import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublisher } from '../src/main/publisher.js';
import { createOperatorStore } from '../src/main/operator-store.js';
import { SEL, BSC, CHUNK_BYTES, OPERATOR_TTL } from '../src/main/config.js';
import { hexToBytes, bytesToHex, decodeResult } from '../src/main/abi.js';
import { keccak256 } from '../src/main/keccak.js';
import { RpcError } from '../src/main/rpc.js';

const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
const file = (path, size, fill = 1) => { const bytes = new Uint8Array(size).fill(fill); return { path, bytes, sha256: sha(bytes) }; };

const OWNER = '0x' + '1'.repeat(40);
const CONTAINER = '0x' + '2'.repeat(40);
const CIRCUITS = '0x' + '3'.repeat(40);
const target = { circuits: CIRCUITS, tokenId: 7, cpu: '#7', label: 'demo' };
const FEE = 5000000000000000n;
const PRICE = 50000000n;
const T0 = 1700000000000;

// 假加密：反转后加前缀
const encrypt = (s) => Buffer.from('enc:' + [...s].reverse().join(''), 'utf8');
const decrypt = (buf) => [...Buffer.from(buf).toString('utf8').slice(4)].reverse().join('');
const hashOf = (raw) => bytesToHex(keccak256(hexToBytes(raw)));
const lower = (a) => String(a).toLowerCase();

// 测试用的最小 RLP 解码器（同 operator.test.mjs）
function rlpItem(b, i) {
  const p = b[i];
  if (p < 0x80) return [b.subarray(i, i + 1), i + 1];
  const readLen = (n, at) => { let l = 0; for (let k = 0; k < n; k++) l = l * 256 + b[at + k]; return l; };
  let isList, len, start;
  if (p < 0xb8) { isList = false; len = p - 0x80; start = i + 1; }
  else if (p < 0xc0) { isList = false; const n = p - 0xb7; len = readLen(n, i + 1); start = i + 1 + n; }
  else if (p < 0xf8) { isList = true; len = p - 0xc0; start = i + 1; }
  else { isList = true; const n = p - 0xf7; len = readLen(n, i + 1); start = i + 1 + n; }
  const end = start + len;
  if (!isList) return [b.subarray(start, end), end];
  const out = [];
  let j = start;
  while (j < end) { const [x, nj] = rlpItem(b, j); out.push(x); j = nj; }
  return [out, end];
}
const big = (b) => (b.length ? BigInt(bytesToHex(b)) : 0n);
function decodeRaw(raw) {
  const [[nonce, gasPrice, gas, to, value, data]] = rlpItem(hexToBytes(raw), 0);
  return { nonce: big(nonce), gasPrice: big(gasPrice), gas: big(gas), to: bytesToHex(to), value: big(value), data: bytesToHex(data) };
}

const args = (data, types) => decodeResult(types, '0x' + data.slice(10));
const gasOf = (tx) => 21000n + BigInt((tx.data.length - 2) / 2) * 20n;

/**
 * 带状态的假链：电路、容器里的文件、操作员授权、余额、nonce、回执都在内存里。
 * ownerSend 和 sendRaw 默认立刻出块；hooks 让测试制造广播失败、回滚、估算回滚、余额被清空之类的情况
 */
function fakeChain({ clock, store, opened = true }) {
  const c = {
    block: 100n, circuit: { owner: OWNER, opened, deployed: opened },
    files: new Map(), grant: { operator: null, until: 0 }, balances: new Map(), nonces: new Map(),
    receipts: new Map(), sent: [], mined: [], ownerTxs: [], calls: [], hooks: {},
    nowSec: () => Math.floor(clock.t / 1000),
    opAddr: () => store.get(BSC.chainId, CONTAINER)?.address,
    canEdit: (who) => lower(who) === lower(c.circuit.owner)
      || (c.grant.operator && lower(who) === lower(c.grant.operator) && c.grant.until > c.nowSec()),
    bal: (a) => c.balances.get(lower(a)) ?? 0n,

    /** 执行一笔交易，返回是否成功；失败时状态不变 */
    apply(from, tx) {
      const sel = tx.data.slice(0, 10);
      if (tx.data === '0x') {
        c.balances.set(lower(tx.to), c.bal(tx.to) + tx.value);
        return true;
      }
      if (sel === SEL.open) {
        if (tx.value !== FEE || c.circuit.opened) return false;
        c.circuit.opened = true;
        c.circuit.deployed = true;
        return true;
      }
      if (sel === SEL.setOperator) {
        const [, operator, ttl] = args(tx.data, ['address', 'address', 'uint']);
        if (lower(from) !== lower(c.circuit.owner)) return false;
        c.grant = { operator, until: c.nowSec() + Number(ttl) };
        return true;
      }
      if (!c.canEdit(from)) return false;
      if (sel === SEL.putFile) {
        const [, path, contentType, sha256, bytes] = args(tx.data, ['address', 'string', 'string', 'bytes32', 'bytes']);
        c.files.set(path, { contentType, sha256, chunks: [hexToBytes(bytes)] });
        return true;
      }
      if (sel === SEL.appendChunk) {
        const [, path, index, bytes] = args(tx.data, ['address', 'string', 'uint', 'bytes']);
        const f = c.files.get(path);
        if (!f || BigInt(f.chunks.length) !== index) return false;
        f.chunks.push(hexToBytes(bytes));
        return true;
      }
      return false;
    },
    mine(hash, from, tx, price, extra = {}) {
      const ok = c.apply(from, tx);
      c.block += 1n;
      const gasUsed = gasOf(tx);
      const r = { transactionHash: hash, status: ok ? 1 : 0, blockNumber: c.block, gasUsed, effectiveGasPrice: price, ...extra };
      c.receipts.set(hash, r);
      return r;
    },

    async ownerSend(tx) {
      c.ownerTxs.push(tx);
      if (c.hooks.ownerSend) return c.hooks.ownerSend(tx);
      const hash = bytesToHex(keccak256(new TextEncoder().encode('owner:' + c.ownerTxs.length)));
      c.mine(hash, tx.from, tx, PRICE);
      return hash;
    },
    async sendRaw(raw) {
      c.sent.push(raw);
      const hash = hashOf(raw);
      if (c.receipts.has(hash)) return { known: true, reason: 'nonceUsed' };
      if (c.hooks.failSend?.(raw)) throw new Error('network down');
      const tx = decodeRaw(raw);
      const from = c.opAddr();
      const nonce = c.nonces.get(from) ?? 0n;
      if (tx.nonce !== nonce) return { known: true, reason: 'nonceUsed' };
      if (c.bal(from) < tx.gas * tx.gasPrice) throw new RpcError('insufficient funds for gas * price + value', -32000);
      c.nonces.set(from, nonce + 1n);
      c.balances.set(from, c.bal(from) - gasOf(tx) * tx.gasPrice);
      const r = c.hooks.revert?.(tx)
        ? (c.block += 1n, { transactionHash: hash, status: 0, blockNumber: c.block, gasUsed: gasOf(tx), effectiveGasPrice: tx.gasPrice })
        : c.mine(hash, from, tx, tx.gasPrice);
      if (r.status === 0) c.receipts.set(hash, r);
      c.mined.push({ hash, tx, receipt: r });
      c.hooks.afterMine?.(tx, r);
      return hash;
    },
    async receipt(hash) { return c.receipts.get(hash) ?? null; },
    async nonceOf(a) { const n = c.nonces.get(lower(a)) ?? 0n; return { latest: n, pending: n, nodes: 2 }; },
    async nativeBalance(a) { return c.bal(a); },
    async pinBlock() { return '0x' + c.block.toString(16); },
    async gasPrice() { return PRICE; },
    async openFee() { return FEE; },
    async circuitInfos(list, block) {
      c.calls.push(['circuitInfos', block]);
      return [{ exists: true, owner: c.circuit.owner, container: CONTAINER, opened: c.circuit.opened }];
    },
    async isDeployed() { return c.circuit.deployed; },
    async fileInfos(pairs) {
      return pairs.map(({ path }) => {
        const f = c.files.get(path);
        if (!f) return null;
        return { size: f.chunks.reduce((n, x) => n + x.length, 0), contentType: f.contentType, sha256: f.sha256, updatedAt: 1, chunkCount: f.chunks.length };
      });
    },
    async operatorState(container, operator, block) {
      c.calls.push(['operatorState', block]);
      return { canEdit: c.canEdit(operator), until: c.grant.until };
    },
    async estimateGas(tx) {
      c.calls.push(['estimateGas', tx]);
      if (c.hooks.estimate) {
        const v = c.hooks.estimate(tx);
        if (v !== undefined) return v;
      }
      // 在当前状态上模拟一遍，不留下改动
      const snapshot = new Map([...c.files].map(([k, v]) => [k, { ...v, chunks: [...v.chunks] }]));
      const ok = c.apply(tx.from, tx);
      c.files = snapshot;
      if (!ok) throw new RpcError('execution reverted', 3, '0x08c379a0');
      return gasOf(tx);
    },
  };
  return c;
}

function setup({ opened = true, files: local = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'publisher-run-'));
  const clock = { t: T0, sleeps: 0 };
  const sleep = async (ms) => { clock.sleeps++; clock.t += ms; };
  const now = () => clock.t;
  const store = createOperatorStore({ dir, encrypt, decrypt, now });
  const chain = fakeChain({ clock, store, opened });
  const make = () => createPublisher({
    chain, net: BSC, ownerSend: (tx) => chain.ownerSend(tx), store,
    readFiles: async () => local, precheck: async () => ({ items: [] }), now, sleep,
  });
  const p = make();
  return { dir, clock, store, chain, p, make, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 容器里的文件内容拼起来，和本地字节比较 */
const content = (chain, path) => Buffer.concat((chain.files.get(path)?.chunks ?? []).map((x) => Buffer.from(x)));
const sameBytes = (chain, f) => content(chain, f.path).equals(Buffer.from(f.bytes));
const uploads = (chain) => chain.mined.filter((m) => m.tx.data.startsWith(SEL.putFile) || m.tx.data.startsWith(SEL.appendChunk));
const ownerKinds = (chain) => chain.ownerTxs.map((tx) => (tx.data === '0x' ? 'fund' : tx.data.startsWith(SEL.open) ? 'open' : tx.data.startsWith(SEL.setOperator) ? 'grant' : '?'));
const spentOf = (mined) => mined.reduce((n, m) => n + m.receipt.gasUsed * m.receipt.effectiveGasPrice, 0n);

// 3 个文件：一个两块的 big.png，a.js，index.html（最后传）
const threeFiles = () => [file('a.js', 100, 2), file('big.png', CHUNK_BYTES + 500, 3), file('index.html', 300, 4)];

test('已开通、空容器：授权、充值，按顺序传完 3 个文件（含两块的文件），返回上传笔数和花费', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    const inspected = await s.p.inspect({ target });
    assert.equal(inspected.stage, 'ready');
    const progress = [];
    const r = await s.p.run(inspected, { onProgress: (e) => progress.push(e) });
    const up = uploads(s.chain);
    assert.deepEqual(up.map((m) => m.receipt.status), [1, 1, 1, 1]);
    assert.equal(r.stage, 'uploaded');
    assert.equal(r.container, CONTAINER);
    assert.equal(r.label, 'demo');
    assert.equal(r.uploaded, 4);
    assert.equal(r.reused, 0);
    assert.equal(r.spent, spentOf(up));
    assert.equal(r.lastBlock, up[3].receipt.blockNumber);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
    assert.equal(s.chain.files.get('big.png').chunks.length, 2);
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
    // 授权给了临时钱包，6 小时
    const op = s.store.get(BSC.chainId, CONTAINER).address;
    assert.equal(lower(s.chain.grant.operator), op);
    assert.equal(s.chain.grant.until, Math.floor(T0 / 1000) + OPERATOR_TTL);
    // 首页最后传
    const paths = progress.filter((e) => e.stage === 'upload').map((e) => [e.path, e.index]);
    assert.deepEqual(paths, [['a.js', 0], ['big.png', 0], ['big.png', 1], ['index.html', 0]]);
    const last = progress.filter((e) => e.stage === 'upload').at(-1);
    assert.equal(last.done, 4);
    assert.equal(last.total, 4);
    assert.equal(last.hash, up[3].hash);
    assert.ok(progress.some((e) => e.stage === 'grant' && e.hash) && progress.some((e) => e.stage === 'fund' && e.hash));
    // 每笔上传的 gas 用临时钱包地址估算
    const ests = s.chain.calls.filter(([n, tx]) => n === 'estimateGas' && lower(tx.from) === op);
    assert.equal(ests.length, 4);
    // 授权确认后在回执的区块上再读一次
    const grantBlock = s.chain.receipts.get([...s.chain.receipts.keys()][0]).blockNumber;
    assert.ok(s.chain.calls.some(([n, b]) => n === 'operatorState' && BigInt(b) === grantBlock));
  } finally { s.done(); }
});

test('没开通：先付开通费开通，核对后再授权、充值、上传', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    const inspected = await s.p.inspect({ target });
    assert.equal(inspected.opened, false);
    const r = await s.p.run(inspected);
    assert.equal(r.stage, 'uploaded');
    assert.equal(r.uploaded, 4);
    assert.deepEqual(ownerKinds(s.chain), ['open', 'grant', 'fund']);
    assert.equal(s.chain.ownerTxs[0].value, FEE);
    assert.equal(s.chain.circuit.opened, true);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
    // 开通之后的读取不早于开通交易的区块
    const openBlock = [...s.chain.receipts.values()][0].blockNumber;
    const later = s.chain.calls.filter(([n]) => n === 'circuitInfos').slice(1);
    assert.ok(later.length > 0 && later.every(([, b]) => BigInt(b) >= openBlock));
  } finally { s.done(); }
});

test('开通交易回执 status 0：抛出开通容器失败', async () => {
  const s = setup({ opened: false, files: threeFiles() });
  try {
    const inspected = await s.p.inspect({ target });
    s.chain.circuit.opened = true; // 开通前被别人抢先开通，合约拒绝重复开通
    await assert.rejects(s.p.run(inspected), /开通容器失败/);
  } finally { s.done(); }
});

test('持有人的交易一直不确认：超时报错，可以稍后继续', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.hooks.ownerSend = async () => '0x' + 'ee'.repeat(32);
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /持有人的交易还没确认，可以稍后继续/);
  } finally { s.done(); }
});

test('中途 abort：在两笔交易之间停下；再 run 一次接着传完，已确认的块不重传', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    const signal = { aborted: false };
    s.chain.hooks.afterMine = () => { if (uploads(s.chain).length === 2) signal.aborted = true; };
    const r1 = await s.p.run(await s.p.inspect({ target }), { signal });
    assert.deepEqual(r1, { stage: 'paused' });
    assert.equal(uploads(s.chain).length, 2);
    assert.equal(s.chain.files.get('big.png').chunks.length, 1);

    s.chain.hooks.afterMine = null;
    const r2 = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r2.stage, 'uploaded');
    assert.equal(r2.uploaded, 2);
    const keys = uploads(s.chain).map((m) => m.tx.data.slice(0, 10) + ':' + m.hash);
    assert.equal(uploads(s.chain).length, 4);
    assert.equal(new Set(keys).size, 4);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
    // 授权还在有效期内，第二次不再授权
    assert.equal(ownerKinds(s.chain).filter((k) => k === 'grant').length, 1);
  } finally { s.done(); }
});

test('abort 已经置位：持有人的交易之前就停下，什么都不发', async () => {
  const s = setup({ opened: false, files: threeFiles() });
  try {
    const r = await s.p.run(await s.p.inspect({ target }), { signal: { aborted: true } });
    assert.deepEqual(r, { stage: 'paused' });
    assert.equal(s.chain.ownerTxs.length, 0);
  } finally { s.done(); }
});

test('上传时广播失败：报错保留 pending；重启后 settle 重发同一笔，算进上传笔数，再接着传完', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    let failed = false;
    s.chain.hooks.failSend = () => (failed ? false : (failed = true));
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /network down/);
    const pending = s.store.get(BSC.chainId, CONTAINER).pending;
    assert.equal(pending.path, 'a.js');
    assert.equal(uploads(s.chain).length, 0);

    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.equal(r.uploaded, 4);
    assert.equal(s.chain.sent.filter((raw) => raw === pending.raw).length, 2);
    assert.equal(uploads(s.chain)[0].hash, pending.hash);
    assert.equal(uploads(s.chain).length, 4);
    assert.equal(s.store.get(BSC.chainId, CONTAINER).pending, null);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('首页替换：链上已有旧首页（两块），新首页整个重传；内容相同的文件复用', async () => {
  const a = file('a.js', 100, 2);
  const index = file('index.html', 500, 9);
  const s = setup({ files: [a, index] });
  try {
    s.chain.files.set('a.js', { contentType: 'text/javascript', sha256: a.sha256, chunks: [a.bytes] });
    s.chain.files.set('index.html', { contentType: 'text/html', sha256: '0x' + 'cd'.repeat(32), chunks: [new Uint8Array(CHUNK_BYTES), new Uint8Array(10)] });
    const inspected = await s.p.inspect({ target });
    assert.equal(inspected.plan.rows.find((r) => r.path === 'index.html').action, 'replace');
    const r = await s.p.run(inspected);
    assert.equal(r.stage, 'uploaded');
    assert.equal(r.uploaded, 1);
    assert.equal(r.reused, 1);
    assert.ok(sameBytes(s.chain, index));
    assert.equal(s.chain.files.get('index.html').sha256, index.sha256);
  } finally { s.done(); }
});

test('余额不够：上传途中余额被花掉，下一笔之前再充一次值', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    let drained = false;
    s.chain.hooks.afterMine = () => {
      if (drained) return;
      drained = true;
      s.chain.balances.set(s.chain.opAddr(), 0n);
    };
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund', 'fund']);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('节点估出的 gas 比 stepGas 大：充值按这一笔的 gasLimit 补足，不会原地打转', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    s.chain.hooks.estimate = (tx) => (lower(tx.from) === s.chain.opAddr() ? 10000000n : undefined);
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    // 每笔 gasLimit = 10000000 × 1.25
    for (const m of uploads(s.chain)) assert.equal(m.tx.gas, 12500000n);
    const funds = s.chain.ownerTxs.filter((tx) => tx.data === '0x');
    assert.ok(funds.length >= 2);
    assert.ok(funds.every((tx) => tx.value > 0n));
  } finally { s.done(); }
});

test('上传回执 status 0：停下并报出哪个文件的第几块', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.hooks.revert = (tx) => tx.data.startsWith(SEL.appendChunk);
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /上传 big\.png 第 1 块失败/);
    // 回滚的那笔也上了链（扣了 gas），之后不再发
    assert.deepEqual(uploads(s.chain).map((m) => m.receipt.status), [1, 1, 0]);
    assert.equal(s.store.get(BSC.chainId, CONTAINER).pending, null);
  } finally { s.done(); }
});

test('授权快过期（不到 5 分钟）：重新授权', async () => {
  const s = setup({ files: threeFiles() });
  try {
    const op = s.store.create({ chainId: BSC.chainId, container: CONTAINER, owner: OWNER }).address;
    s.chain.grant = { operator: op, until: Math.floor(T0 / 1000) + 100 };
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
    assert.equal(s.chain.grant.until, Math.floor(T0 / 1000) + OPERATOR_TTL);
  } finally { s.done(); }
});

test('授权还有很久：不重新授权', async () => {
  const s = setup({ files: threeFiles() });
  try {
    const op = s.store.create({ chainId: BSC.chainId, container: CONTAINER, owner: OWNER }).address;
    s.chain.grant = { operator: op, until: Math.floor(T0 / 1000) + 3600 };
    await s.p.run(await s.p.inspect({ target }));
    assert.deepEqual(ownerKinds(s.chain), ['fund']);
  } finally { s.done(); }
});

test('授权交易确认了但链上没生效：抛出授权没有生效', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.hooks.ownerSend = async (tx) => {
      const hash = '0x' + 'ab'.repeat(32);
      s.chain.block += 1n;
      s.chain.receipts.set(hash, { transactionHash: hash, status: 1, blockNumber: s.chain.block, gasUsed: 21000n, effectiveGasPrice: PRICE });
      return hash;
    };
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /授权没有生效/);
  } finally { s.done(); }
});

test('同一个容器并发 run：第二个直接拒绝；第一个结束后可以再 run', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    const inspected = await s.p.inspect({ target });
    const first = s.p.run(inspected);
    await assert.rejects(s.make().run(inspected), /这个容器正在发布/);
    assert.equal((await first).stage, 'uploaded');
    const again = await s.make().run(await s.p.inspect({ target }));
    assert.equal(again.stage, 'uploaded');
    assert.equal(again.uploaded, 0);
    assert.equal(again.reused, 3);
  } finally { s.done(); }
});

test('出错之后互斥锁也会释放', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.hooks.revert = (tx) => tx.data.startsWith(SEL.appendChunk);
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /第 1 块失败/);
    s.chain.hooks.revert = null;
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
  } finally { s.done(); }
});

test('估算回滚（节点落后）：隔一个 pollMs 重试，第三次成功就继续', async () => {
  const s = setup({ files: threeFiles() });
  try {
    let reverts = 0;
    s.chain.hooks.estimate = (tx) => {
      if (lower(tx.from) !== s.chain.opAddr() || reverts >= 2) return undefined;
      reverts++;
      throw new RpcError('execution reverted', 3, '0x');
    };
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.equal(reverts, 2);
    assert.ok(s.clock.sleeps >= 2);
  } finally { s.done(); }
});

test('估算一直回滚：重试两次后停下，报出模拟失败', async () => {
  const s = setup({ files: threeFiles() });
  try {
    let n = 0;
    s.chain.hooks.estimate = (tx) => {
      if (lower(tx.from) !== s.chain.opAddr()) return undefined;
      n++;
      throw new RpcError('execution reverted: nope', 3, '0x');
    };
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /上传 a\.js 第 0 块模拟失败：.*nope/);
    assert.equal(n, 3);
    assert.equal(uploads(s.chain).length, 0);
  } finally { s.done(); }
});

test('估算遇到节点故障（不是回滚）：用这一步的 stepGas 作 gasLimit', async () => {
  const s = setup({ files: [file('index.html', 300, 4)] });
  try {
    s.chain.hooks.estimate = (tx) => {
      if (lower(tx.from) === s.chain.opAddr()) throw new Error('timeout');
      return undefined;
    };
    const inspected = await s.p.inspect({ target });
    const fresh = await s.p.inspect({ target, files: inspected.files, simulate: false });
    const r = await s.p.run(inspected);
    assert.equal(r.stage, 'uploaded');
    assert.equal(uploads(s.chain)[0].tx.gas, fresh.stepGas[0]);
  } finally { s.done(); }
});

test('gas 单价太高：上传前停下', async () => {
  const s = setup({ files: threeFiles() });
  try {
    const inspected = await s.p.inspect({ target });
    s.chain.gasPrice = async () => 200000000n;
    await assert.rejects(s.p.run(inspected), /当前 Gas 单价太高/);
    assert.equal(uploads(s.chain).length, 0);
  } finally { s.done(); }
});
