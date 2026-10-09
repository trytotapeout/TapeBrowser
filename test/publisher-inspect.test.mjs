import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPublisher } from '../src/main/publisher.js';
import { BSC, BASE, CHUNK_BYTES, MAX_GAS_PRICE, MAX_UPLOAD_GAS } from '../src/main/config.js';
import { uploadTx } from '../src/main/publish-tx.js';

const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
const file = (path, size, fill = 1) => { const bytes = new Uint8Array(size).fill(fill); return { path, bytes, sha256: sha(bytes) }; };

const OWNER = '0x' + '1'.repeat(40);
const CONTAINER = '0x' + '2'.repeat(40);
const CIRCUITS = '0x' + '3'.repeat(40);
const target = { circuits: CIRCUITS, tokenId: 7, cpu: '#7', label: 'demo' };
const FEE = 5000000000000000n;
const PRICE = 50000000n;

// 假链：记录调用，返回可配置的结果
function fakeChain({ exists = true, opened = true, infos = {}, gasPrice = PRICE, estimate = null } = {}) {
  const calls = [];
  return {
    calls,
    async circuitInfos(list) { calls.push(['circuitInfos', list]); return [{ exists, owner: OWNER, container: CONTAINER, opened }]; },
    async fileInfos(list) { calls.push(['fileInfos', list]); return list.map((q) => infos[q.path] ?? null); },
    async openFee() { calls.push(['openFee']); return FEE; },
    async gasPrice() { calls.push(['gasPrice']); return gasPrice; },
    async estimateGas(tx) {
      calls.push(['estimateGas', tx]);
      if (estimate instanceof Error) throw estimate;
      return estimate ?? 1n;
    },
  };
}

const okPrecheck = async () => ({ items: [{ level: 'warn', text: '提醒' }] });
const make = ({ chain = fakeChain(), net = BSC, files = [], precheck = okPrecheck } = {}) =>
  createPublisher({ chain, net, ownerSend: async () => { throw new Error('不该调用'); }, store: {}, readFiles: async () => files, precheck });

// 测试里按公式算每一块的 gas 上限
const bound = (len) => {
  const g = 21000n + BigInt(len) * 16n + BigInt(len) * 200n + 100000n;
  return g > MAX_UPLOAD_GAS ? MAX_UPLOAD_GAS : g;
};

test('链不支持发布就抛出', async () => {
  await assert.rejects(make({ net: BASE }).inspect({ target }), /这条链暂时不支持发布/);
});

test('预检查有错误：返回 blocked，只带错误项，不读链', async () => {
  const chain = fakeChain();
  const precheck = async () => ({ items: [{ level: 'warn', text: 'w' }, { level: 'error', text: '没有 index.html' }] });
  const r = await make({ chain, precheck, files: [file('index.html', 10)] }).inspect({ target });
  assert.deepEqual(r, { stage: 'blocked', errors: [{ level: 'error', text: '没有 index.html' }] });
  assert.equal(chain.calls.length, 0);
});

test('电路不存在就抛出', async () => {
  await assert.rejects(make({ chain: fakeChain({ exists: false }), files: [file('index.html', 10)] }).inspect({ target }), /这个电路不存在/);
});

test('没开通：带开通费，不读文件信息，不估 gas，总花费加上开通费', async () => {
  const chain = fakeChain({ opened: false });
  const files = [file('index.html', 100), file('big.png', 30000)];
  const r = await make({ chain, files }).inspect({ target });
  assert.equal(r.stage, 'ready');
  assert.equal(r.opened, false);
  assert.equal(r.openFee, FEE);
  assert.equal(r.owner, OWNER);
  assert.equal(r.container, CONTAINER);
  assert.equal(r.target, target);
  assert.deepEqual(r.steps.map((s) => [s.path, s.index]), [['big.png', 0], ['big.png', 1], ['index.html', 0]]);
  const gas = (bound(CHUNK_BYTES) + bound(30000 - CHUNK_BYTES) + bound(100)) * 12n / 10n;
  assert.equal(r.uploadGas, gas);
  assert.equal(r.uploadCost, gas * PRICE);
  assert.equal(r.totalCost, gas * PRICE + FEE);
  assert.ok(!chain.calls.some(([n]) => n === 'fileInfos' || n === 'estimateGas'));
  assert.deepEqual(chain.calls[0], ['circuitInfos', [{ circuits: CIRCUITS, tokenId: 7 }]]);
});

test('已开通有冲突：返回 conflicts，不估费用', async () => {
  const old = file('a.js', 10, 1);
  const chain = fakeChain({ infos: { 'a.js': { size: 10, contentType: '', sha256: old.sha256, updatedAt: 1, chunkCount: 1 } } });
  const r = await make({ chain, files: [file('a.js', 10, 2), file('index.html', 10)] }).inspect({ target });
  assert.equal(r.stage, 'conflicts');
  assert.deepEqual(r.conflicts, [{ path: 'a.js', reason: 'changed' }]);
  assert.ok(r.plan);
  assert.ok(!chain.calls.some(([n]) => n === 'gasPrice' || n === 'openFee'));
});

test('已开通正常：读全部文件信息，交易笔数和费用对得上，第一笔用 estimateGas 估', async () => {
  const same = file('a.js', 10);
  const files = [file('index.html', 200), same, file('b.css', 50000)];
  const chain = fakeChain({ infos: { 'a.js': { size: 10, contentType: '', sha256: same.sha256, updatedAt: 1, chunkCount: 1 } }, estimate: 1n });
  const r = await make({ chain, files }).inspect({ target });
  assert.equal(r.stage, 'ready');
  assert.equal(r.opened, true);
  assert.equal(r.openFee, 0n);
  const fi = chain.calls.find(([n]) => n === 'fileInfos');
  assert.deepEqual(fi[1], files.map((f) => ({ container: CONTAINER, path: f.path })));
  assert.equal(r.plan.transactions, 4);
  assert.equal(r.steps.length, 4);
  const est = chain.calls.find(([n]) => n === 'estimateGas')[1];
  assert.deepEqual(est, { from: OWNER, ...uploadTx(BSC, CONTAINER, r.steps[0]) });
  const gas = (bound(CHUNK_BYTES) * 2n + bound(50000 - 2 * CHUNK_BYTES) + bound(200)) * 12n / 10n;
  assert.equal(r.uploadGas, gas);
  assert.equal(r.gasPrice, PRICE);
  assert.equal(r.uploadCost, gas * PRICE);
  assert.equal(r.totalCost, gas * PRICE);
});

test('estimateGas 比上限大：第一笔用估出来的值', async () => {
  const chain = fakeChain({ estimate: 2000000n });
  const r = await make({ chain, files: [file('a.js', 10), file('index.html', 20)] }).inspect({ target });
  const gas = (2000000n + bound(20)) * 12n / 10n;
  assert.equal(r.uploadGas, gas);
  assert.equal(r.uploadCost, gas * PRICE);
});

test('estimateGas 失败：退回上限，不影响结果', async () => {
  const chain = fakeChain({ estimate: new Error('execution reverted') });
  const r = await make({ chain, files: [file('a.js', 10), file('index.html', 20)] }).inspect({ target });
  assert.equal(r.stage, 'ready');
  assert.equal(r.uploadGas, (bound(10) + bound(20)) * 12n / 10n);
});

test('全部复用：没有要传的块，不估 gas，费用为 0', async () => {
  const f = file('index.html', 10);
  const chain = fakeChain({ infos: { 'index.html': { size: 10, contentType: '', sha256: f.sha256, updatedAt: 1, chunkCount: 1 } } });
  const r = await make({ chain, files: [f] }).inspect({ target });
  assert.equal(r.steps.length, 0);
  assert.equal(r.uploadCost, 0n);
  assert.equal(r.totalCost, 0n);
  assert.ok(!chain.calls.some(([n]) => n === 'estimateGas'));
});

test('gasPrice 超限或为 0 就抛出', async () => {
  for (const gasPrice of [MAX_GAS_PRICE + 1n, 0n]) {
    await assert.rejects(make({ chain: fakeChain({ gasPrice }), files: [file('index.html', 10)] }).inspect({ target }), /当前 Gas 单价太高，请稍后再试/);
  }
  // 正好等于上限可以
  const r = await make({ chain: fakeChain({ gasPrice: MAX_GAS_PRICE }), files: [file('index.html', 10)] }).inspect({ target });
  assert.equal(r.gasPrice, MAX_GAS_PRICE);
});
