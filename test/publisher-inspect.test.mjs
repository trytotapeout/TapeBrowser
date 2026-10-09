import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPublisher, stepGasBound } from '../src/main/publisher.js';
import { SEL, BSC, BASE, CHUNK_BYTES, MAX_GAS_PRICE, MAX_UPLOAD_GAS, MAX_FILE_BYTES } from '../src/main/config.js';
import { uploadTx } from '../src/main/publish-tx.js';
import { guessType } from '../src/main/tape-protocol.js';
import { RpcError } from '../src/main/rpc.js';

const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
const file = (path, size, fill = 1) => { const bytes = new Uint8Array(size).fill(fill); return { path, bytes, sha256: sha(bytes) }; };

const OWNER = '0x' + '1'.repeat(40);
const CONTAINER = '0x' + '2'.repeat(40);
const CIRCUITS = '0x' + '3'.repeat(40);
const BLOCK = '0x10';
const target = { circuits: CIRCUITS, tokenId: 7, cpu: '#7', label: 'demo' };
const FEE = 5000000000000000n;
const PRICE = 50000000n;

// 从 appendChunk 的 calldata 里取出路径和块序号（address, string, uint, bytes）
function decodeAppend(data) {
  const word = (i) => BigInt('0x' + data.slice(10 + i * 64, 10 + (i + 1) * 64));
  const at = Number(word(1)) * 2 + 10;
  const len = Number(BigInt('0x' + data.slice(at, at + 64)));
  const path = Buffer.from(data.slice(at + 64, at + 64 + len * 2), 'hex').toString('utf8');
  return { path, index: Number(word(2)) };
}

// 假链：记录调用（含 block 参数），返回可配置的结果；estimate 可以是数值、Error 或 (tx) => 数值。
// 和真合约一样，appendChunk 只有在链上已有这个文件、块数正好等于 index 时才能模拟成功，否则回滚
function fakeChain({ exists = true, opened = true, infos = {}, gasPrice = PRICE, estimate = null, pinned = BLOCK } = {}) {
  const calls = [];
  return {
    calls,
    async pinBlock() { calls.push(['pinBlock']); return pinned; },
    async circuitInfos(list, block) { calls.push(['circuitInfos', list, block]); return [{ exists, owner: OWNER, container: CONTAINER, opened }]; },
    async fileInfos(list, block) { calls.push(['fileInfos', list, block]); return list.map((q) => infos[q.path] ?? null); },
    async openFee(block) { calls.push(['openFee', block]); return FEE; },
    async gasPrice() { calls.push(['gasPrice']); return gasPrice; },
    async estimateGas(...args) {
      calls.push(['estimateGas', ...args]);
      const [tx] = args;
      if (tx.data.startsWith(SEL.appendChunk)) {
        const { path, index } = decodeAppend(tx.data);
        if (infos[path]?.chunkCount !== index) throw new RpcError('execution reverted: bad chunk index', 3, '0x08c379a0');
      }
      if (estimate instanceof Error) throw estimate;
      if (typeof estimate === 'function') return estimate(tx);
      return estimate ?? 1n;
    },
  };
}
const called = (chain, name) => chain.calls.filter(([n]) => n === name);

const okPrecheck = async () => ({ items: [{ level: 'warn', text: '提醒' }] });
function make({ chain = fakeChain(), net = BSC, files = [], precheck = okPrecheck } = {}) {
  const seen = { readFiles: 0, precheck: 0 };
  const p = createPublisher({
    chain, net, ownerSend: async () => { throw new Error('不该调用'); }, store: {},
    readFiles: async () => { seen.readFiles++; return files; },
    precheck: async () => { seen.precheck++; return precheck(); },
  });
  p.seen = seen;
  return p;
}

// 测试里按公式独立算每一笔的 gas 上限
const utf8 = (s) => BigInt(new TextEncoder().encode(s).length);
const slots = (n) => (n + 31n) / 32n;
const bytePart = (len) => BigInt(len) * 16n + (BigInt(len) + 1n) * 200n;
const cap = (g) => (g > MAX_UPLOAD_GAS ? MAX_UPLOAD_GAS : g);
const putBound = (path, len) => cap(21000n + 32000n + 150000n + 22100n * slots(utf8(path)) + 22100n * slots(utf8(guessType(path))) + bytePart(len));
const appendBound = (len) => cap(21000n + 32000n + 80000n + bytePart(len));
const pad = (g) => cap(g * 125n / 100n);
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const resumed = (f, count) => ({ size: count * CHUNK_BYTES, contentType: '', sha256: f.sha256, updatedAt: 1, chunkCount: count });
const done = (f) => ({ size: f.bytes.length, contentType: '', sha256: f.sha256, updatedAt: 1, chunkCount: 1 });

test('链不支持发布就抛出', async () => {
  await assert.rejects(make({ net: BASE }).inspect({ target }), /这条链暂时不支持发布/);
});

test('预检查有错误：返回 blocked，只带错误项，不读链', async () => {
  const chain = fakeChain();
  const precheck = async () => ({ items: [{ level: 'warn', text: 'w' }, { level: 'error', text: '没有 index.html' }] });
  const p = make({ chain, precheck, files: [file('index.html', 10)] });
  const r = await p.inspect({ target });
  assert.deepEqual(r, { stage: 'blocked', errors: [{ level: 'error', text: '没有 index.html' }] });
  assert.equal(chain.calls.length, 0);
  assert.equal(p.seen.readFiles, 0);
});

test('电路不存在就抛出', async () => {
  await assert.rejects(make({ chain: fakeChain({ exists: false }), files: [file('index.html', 10)] }).inspect({ target }), /这个电路不存在/);
});


test('stepGasBound：putFile 和 appendChunk 按各自的公式算，超过上限封顶', () => {
  const f = file('dir/页面.html', 30000);
  const row = { path: f.path, bytes: f.bytes, contentType: guessType(f.path) };
  assert.equal(stepGasBound({ path: f.path, index: 0, row }), putBound(f.path, CHUNK_BYTES));
  assert.equal(stepGasBound({ path: f.path, index: 1, row }), appendBound(30000 - CHUNK_BYTES));
  // 路径 33 个 UTF-8 字节占两个存储槽
  const long = 'a'.repeat(33);
  const r2 = { path: long, bytes: new Uint8Array(1), contentType: 'x' };
  assert.equal(stepGasBound({ path: long, index: 0, row: r2 }), 21000n + 32000n + 150000n + 22100n * 2n + 22100n + bytePart(1));
  // 一块最多 24000 字节到不了上限；路径超长（700 个存储槽）才会封顶
  const huge = 'p'.repeat(32 * 700);
  assert.equal(stepGasBound({ path: huge, index: 0, row: { path: huge, bytes: new Uint8Array(10), contentType: 'x' } }), MAX_UPLOAD_GAS);
});

test('没开通：带开通费，读链都钉在同一个区块，不读文件信息、不估 gas，总花费加上开通费', async () => {
  const chain = fakeChain({ opened: false });
  const files = [file('index.html', 100), file('big.png', 30000)];
  const r = await make({ chain, files }).inspect({ target });
  assert.equal(r.stage, 'ready');
  assert.equal(r.opened, false);
  assert.equal(r.openFee, FEE);
  assert.equal(r.owner, OWNER);
  assert.equal(r.container, CONTAINER);
  assert.equal(r.target, target);
  assert.equal(r.block, BLOCK);
  assert.equal(r.files, files);
  assert.deepEqual(r.steps.map((s) => [s.path, s.index]), [['big.png', 0], ['big.png', 1], ['index.html', 0]]);
  const stepGas = [putBound('big.png', CHUNK_BYTES), appendBound(30000 - CHUNK_BYTES), putBound('index.html', 100)].map(pad);
  assert.deepEqual(r.stepGas, stepGas);
  assert.equal(r.uploadGas, sum(stepGas));
  assert.equal(r.uploadCost, sum(stepGas) * PRICE);
  assert.equal(r.totalCost, sum(stepGas) * PRICE + FEE);
  assert.equal(called(chain, 'fileInfos').length + called(chain, 'estimateGas').length, 0);
  assert.deepEqual(called(chain, 'circuitInfos')[0], ['circuitInfos', [{ circuits: CIRCUITS, tokenId: 7 }], BLOCK]);
  assert.deepEqual(called(chain, 'openFee')[0], ['openFee', BLOCK]);
});

test('已开通有冲突：返回 conflicts，不估费用', async () => {
  const old = file('a.js', 10, 1);
  const chain = fakeChain({ infos: { 'a.js': done(old) } });
  const r = await make({ chain, files: [file('a.js', 10, 2), file('index.html', 10)] }).inspect({ target });
  assert.equal(r.stage, 'conflicts');
  assert.deepEqual(r.conflicts, [{ path: 'a.js', reason: 'changed' }]);
  assert.ok(r.plan);
  assert.equal(called(chain, 'gasPrice').length + called(chain, 'openFee').length, 0);
});

test('已开通正常：fileInfos 钉在同一区块，交易笔数和费用对得上（节点估得比上限小时用上限）', async () => {
  const same = file('a.js', 10);
  const files = [file('index.html', 200), same, file('b.css', 50000)];
  const chain = fakeChain({ infos: { 'a.js': done(same) }, estimate: 1n });
  const r = await make({ chain, files }).inspect({ target });
  assert.equal(r.stage, 'ready');
  assert.equal(r.opened, true);
  assert.equal(r.openFee, 0n);
  assert.deepEqual(called(chain, 'fileInfos')[0], ['fileInfos', files.map((f) => ({ container: CONTAINER, path: f.path })), BLOCK]);
  assert.equal(r.plan.transactions, 4);
  assert.equal(r.steps.length, 4);
  // 只模拟第一笔 putFile：b.css 是新文件，它的 appendChunk 要等 putFile 上链后才能成功，不模拟；模拟不带区块参数
  assert.deepEqual(called(chain, 'estimateGas'), [['estimateGas', { from: OWNER, ...uploadTx(BSC, CONTAINER, r.steps[0]) }]]);
  const stepGas = [putBound('b.css', CHUNK_BYTES), appendBound(CHUNK_BYTES), appendBound(50000 - 2 * CHUNK_BYTES), putBound('index.html', 200)].map(pad);
  assert.deepEqual(r.stepGas, stepGas);
  assert.equal(r.uploadGas, sum(stepGas));
  assert.equal(r.gasPrice, PRICE);
  assert.equal(r.uploadCost, sum(stepGas) * PRICE);
  assert.equal(r.totalCost, sum(stepGas) * PRICE);
});

test('校准：节点估得比上限大时，putFile 和 appendChunk 各按自己的固定开销套到同类型的每一笔', async () => {
  // big.js 3 块已传 1 块（append 两笔），index.html 新建一笔，c.css 新建一笔
  const big = file('big.js', 3 * CHUNK_BYTES);
  const files = [big, file('c.css', 500), file('index.html', 300)];
  const PUT_OVER = 900000n;
  const APP_OVER = 700000n;
  // 计划里的顺序是 big.js#1、big.js#2、c.css#0、index.html#0：第一笔 appendChunk 是 big.js#1，第一笔 putFile 是 c.css#0
  const lenOf = (s) => Math.min(CHUNK_BYTES, s.row.bytes.length - s.index * CHUNK_BYTES);
  const chain = fakeChain({
    infos: { 'big.js': resumed(big, 1) },
    estimate: (tx) => (tx.data.startsWith(SEL.putFile) ? bytePart(500) + PUT_OVER : bytePart(CHUNK_BYTES) + APP_OVER),
  });
  const r = await make({ chain, files }).inspect({ target });
  assert.deepEqual(r.steps.map((s) => [s.path, s.index]), [['big.js', 1], ['big.js', 2], ['c.css', 0], ['index.html', 0]]);
  const [firstApp, , firstPut] = r.steps;
  // 续传的那一行：模拟的就是链上下一块，index === from
  assert.equal(firstApp.row.action, 'append');
  assert.equal(firstApp.index, firstApp.row.from);
  const est = called(chain, 'estimateGas').map((c) => c[1]);
  assert.deepEqual(est, [firstPut, firstApp].map((s) => ({ from: OWNER, ...uploadTx(BSC, CONTAINER, s) })));
  const expected = r.steps.map((s) => {
    const len = lenOf(s);
    const bound = s.index === 0 ? putBound(s.path, len) : appendBound(len);
    const cal = bytePart(len) + (s.index === 0 ? PUT_OVER : APP_OVER);
    return pad(bound > cal ? bound : cal);
  });
  assert.deepEqual(r.stepGas, expected);
  assert.deepEqual(r.stepGas, [bytePart(CHUNK_BYTES) + APP_OVER, bytePart(CHUNK_BYTES) + APP_OVER, bytePart(500) + PUT_OVER, bytePart(300) + PUT_OVER].map(pad));
  assert.equal(r.uploadCost, sum(expected) * PRICE);
});

test('estimateGas 遇到合约回滚：返回 blocked，带上模拟失败的原因', async () => {
  for (const err of [new RpcError('execution reverted: not editor', 3, '0x08c379a0'), new Error('VM Exception: revert'), new RpcError('bad', -32000, '0xdeadbeef')]) {
    const r = await make({ chain: fakeChain({ estimate: err }), files: [file('index.html', 20)] }).inspect({ target });
    assert.deepEqual(r, { stage: 'blocked', errors: [{ level: 'error', text: '链上模拟上传失败：' + err.message }] });
  }
});

test('estimateGas 遇到节点错误（超时、限流）：静默退回上限', async () => {
  for (const err of [new RpcError('RPC timeout', -32603), new RpcError('rate limit', -32005), new RpcError('rate limit', -32005, { retryAfter: 1 }), new RpcError('bad', -32000, '0x'), new Error('fetch failed')]) {
    const r = await make({ chain: fakeChain({ estimate: err }), files: [file('a.js', 10), file('index.html', 20)] }).inspect({ target });
    assert.equal(r.stage, 'ready');
    assert.deepEqual(r.stepGas, [pad(putBound('a.js', 10)), pad(putBound('index.html', 20))]);
  }
});

test('全部复用：没有要传的块，不估 gas，费用为 0', async () => {
  const f = file('index.html', 10);
  const chain = fakeChain({ infos: { 'index.html': done(f) } });
  const r = await make({ chain, files: [f] }).inspect({ target });
  assert.equal(r.steps.length, 0);
  assert.deepEqual(r.stepGas, []);
  assert.equal(r.uploadCost, 0n);
  assert.equal(r.totalCost, 0n);
  assert.equal(called(chain, 'estimateGas').length, 0);
});

test('gasPrice 超限或为 0 就抛出，正好等于上限可以', async () => {
  const run = (gasPrice) => make({ chain: fakeChain({ gasPrice }), files: [file('index.html', 10)] }).inspect({ target });
  await assert.rejects(run(MAX_GAS_PRICE + 1n), /当前 Gas 单价太高，请稍后再试/);
  await assert.rejects(run(0n), /读不到有效的 Gas 单价，请稍后再试/);
  assert.equal((await run(MAX_GAS_PRICE)).gasPrice, MAX_GAS_PRICE);
});

test('传入文件快照：跳过预检查和读文件，直接用快照', async () => {
  const files = [file('index.html', 10)];
  const p = make({ files: [file('index.html', 99)], precheck: async () => ({ items: [{ level: 'error', text: 'x' }] }) });
  const r = await p.inspect({ target, files });
  assert.equal(r.stage, 'ready');
  assert.equal(r.files, files);
  assert.equal(r.plan.rows[0].bytes.length, 10);
  assert.deepEqual(p.seen, { readFiles: 0, precheck: 0 });
});

test('文件快照不再重算 sha256，其他检查照做', async () => {
  // 内容被改过但 sha 还是旧的：快照在第一次 inspect 已经核对过，这里不重算
  const f = file('index.html', 10);
  const changed = { ...f, bytes: new Uint8Array(10).fill(7) };
  assert.equal((await make().inspect({ target, files: [changed] })).stage, 'ready');
  await assert.rejects(make().inspect({ target, files: [{ ...f, path: '../index.html' }] }), /本地文件异常/);
  await assert.rejects(make().inspect({ target, files: [f, f] }), /本地文件异常/);
  await assert.rejects(make().inspect({ target, files: [{ ...f, sha256: 'abc' }] }), /本地文件异常/);
});

test('本地文件异常就抛出，不读文件信息', async () => {
  const ok = file('index.html', 10);
  const bad = [
    ['重复路径', [ok, file('index.html', 10)], 'index.html'],
    ['空路径', [{ ...file('x', 1), path: '' }], ''],
    ['开头是 /', [{ ...file('x', 1), path: '/a.js' }], '/a.js'],
    ['含反斜杠', [{ ...file('x', 1), path: 'a\\b.js' }], 'a\\b.js'],
    ['空段', [{ ...file('x', 1), path: 'a//b.js' }], 'a//b.js'],
    ['. 段', [{ ...file('x', 1), path: 'a/./b.js' }], 'a/./b.js'],
    ['.. 段', [{ ...file('x', 1), path: 'a/../b.js' }], 'a/../b.js'],
    ['结尾 /', [{ ...file('x', 1), path: 'a/' }], 'a/'],
    ['空文件', [file('e.js', 0)], 'e.js'],
    ['太大', [file('big.bin', MAX_FILE_BYTES + 1)], 'big.bin'],
    ['sha 格式不对', [{ ...file('a.js', 5), sha256: 'abc' }], 'a.js'],
    ['sha 大写', [{ ...ok, sha256: ok.sha256.toUpperCase().replace('0X', '0x') }], 'index.html'],
    ['sha 对不上', [{ ...file('a.js', 5), sha256: file('a.js', 5, 9).sha256 }], 'a.js'],
  ];
  for (const [name, files, path] of bad) {
    const chain = fakeChain();
    await assert.rejects(make({ chain, files }).inspect({ target }), (e) => e.message === `本地文件异常：${path}`, name);
    assert.equal(called(chain, 'fileInfos').length, 0, name);
  }
  // 正好 MAX_FILE_BYTES 可以
  const r = await make({ chain: fakeChain({ opened: false }), files: [file('index.html', MAX_FILE_BYTES)] }).inspect({ target });
  assert.equal(r.stage, 'ready');
});

test('新的多块文件：不模拟 appendChunk，不会误判成 blocked', async () => {
  const chain = fakeChain();
  const r = await make({ chain, files: [file('a.bin', 2 * CHUNK_BYTES + 5), file('index.html', 10)] }).inspect({ target });
  assert.equal(r.stage, 'ready');
  const est = called(chain, 'estimateGas');
  assert.equal(est.length, 1);
  assert.ok(est[0][1].data.startsWith(SEL.putFile));
  assert.deepEqual(r.stepGas.slice(1, 3), [appendBound(CHUNK_BYTES), appendBound(5)].map(pad));
});

test('多块 index.html 整个替换：不模拟 appendChunk，不会误判成 blocked', async () => {
  const old = file('index.html', 10, 1);
  const chain = fakeChain({ infos: { 'index.html': done(old) } });
  const r = await make({ chain, files: [file('index.html', CHUNK_BYTES + 100, 2)] }).inspect({ target });
  assert.equal(r.stage, 'ready');
  assert.deepEqual(r.steps.map((s) => [s.row.action, s.index]), [['replace', 0], ['replace', 1]]);
  assert.equal(called(chain, 'estimateGas').length, 1);
});

test('minBlock：节点钉的区块比它旧就用 minBlock，比它新就用节点的', async () => {
  const chain = fakeChain({ opened: false });
  const r = await make({ chain, files: [file('index.html', 10)] }).inspect({ target, minBlock: 20n });
  assert.equal(r.block, '0x14');
  assert.equal(called(chain, 'circuitInfos')[0][2], '0x14');
  assert.equal(called(chain, 'openFee')[0][1], '0x14');
  const r2 = await make({ chain: fakeChain({ opened: false }), files: [file('index.html', 10)] }).inspect({ target, minBlock: 5n });
  assert.equal(r2.block, BLOCK);
});

test('乘 1.25 之后每笔仍然不超过 MAX_UPLOAD_GAS', async () => {
  const path = 'p'.repeat(32 * 700);
  const r = await make({ chain: fakeChain({ opened: false }), files: [file(path, 10)] }).inspect({ target });
  assert.deepEqual(r.stepGas, [MAX_UPLOAD_GAS]);
});

test('simulate: false：不调 estimateGas，每笔按上限 × 1.25 封顶', async () => {
  const f = file('a.js', 30000);
  const chain = fakeChain({ infos: { 'a.js': resumed(f, 1) }, estimate: () => { throw new Error('不该估算'); } });
  const p = make({ chain });
  const r = await p.inspect({ target, files: [f, file('index.html', 10)], simulate: false });
  assert.equal(r.stage, 'ready');
  assert.equal(called(chain, 'estimateGas').length, 0);
  assert.deepEqual(r.stepGas, r.steps.map((s) => pad(stepGasBound(s))));
  assert.equal(r.uploadGas, sum(r.stepGas));
});
