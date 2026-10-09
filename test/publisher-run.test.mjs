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

const cloneState = (s) => ({
  circuit: { ...s.circuit },
  files: new Map([...s.files].map(([k, v]) => [k, { ...v, chunks: [...v.chunks] }])),
  grant: { ...s.grant },
  balances: new Map(s.balances),
});

/**
 * 带状态的假链：电路、容器里的文件、操作员授权、余额、nonce、回执都在内存里。
 * 每出一个块存一份快照，读取按 block 参数返回那个块的状态；lag 让 latest（和 pinBlock）落后几个块，
 * 钉住的区块号比 latest 新时照样能读（rpc 会换到同步了的节点），比链头还新才报 header not found。
 * 默认 ownerSend / sendRaw 立刻出块；holdOwner / holdOps 时先进交易池，mineQueued() 才出块。
 * hooks 让测试制造广播失败、回滚、估算回滚、广播后抛错之类的情况
 */
function fakeChain({ clock, store, opened = true }) {
  const c = {
    head: 100n, lag: 0n, snaps: new Map(),
    circuit: { owner: OWNER, opened, deployed: opened },
    files: new Map(), grant: { operator: null, until: 0 }, balances: new Map(),
    nonces: new Map(), owner: { latest: 0n, pending: 0n }, queue: [], holdOwner: false, holdOps: false,
    receipts: new Map(), sent: [], mined: [], ownerTxs: [], calls: [], hooks: {},
    nowSec: () => Math.floor(clock.t / 1000),
    opAddr: () => store.get(BSC.chainId, CONTAINER)?.address,
    canEdit: (who, s = c) => lower(who) === lower(s.circuit.owner)
      || (s.grant.operator && lower(who) === lower(s.grant.operator) && s.grant.until > c.nowSec()),
    bal: (a, s = c) => s.balances.get(lower(a)) ?? 0n,

    /** 某个区块的状态：链头就是当前状态，更早的用快照（比最早的快照还早就用最早的） */
    at(block) {
      const n = block === undefined || block === 'latest' ? c.head - c.lag : BigInt(block);
      if (n > c.head) throw new RpcError('header not found', -32000);
      if (n === c.head) return c;
      for (let b = n; b >= 0n; b--) if (c.snaps.has(b)) return c.snaps.get(b);
      return c.snaps.get([...c.snaps.keys()].sort((x, y) => (x < y ? -1 : 1))[0]) ?? c;
    },

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
    /** 出一个只含这笔交易的块：先存下出块前的快照 */
    mineTx(hash, from, tx, price, { revert = false, charge = 0n } = {}) {
      c.snaps.set(c.head, cloneState(c));
      if (charge) c.balances.set(lower(from), c.bal(from) - charge);
      const ok = !revert && c.apply(from, tx);
      c.head += 1n;
      const r = { transactionHash: hash, status: ok ? 1 : 0, blockNumber: c.head, gasUsed: gasOf(tx), effectiveGasPrice: price };
      c.receipts.set(hash, r);
      return r;
    },
    mineItem(item) {
      if (item.kind === 'owner') {
        c.owner.latest += 1n;
        return c.mineTx(item.hash, item.tx.from, item.tx, PRICE, { revert: Boolean(c.hooks.revertOwner?.(item.tx)) });
      }
      const { hash, tx, from } = item;
      c.nonces.set(from, (c.nonces.get(from) ?? 0n) + 1n);
      const r = c.mineTx(hash, from, tx, tx.gasPrice, { revert: Boolean(c.hooks.revert?.(tx)), charge: gasOf(tx) * tx.gasPrice });
      c.mined.push({ hash, tx, receipt: r });
      c.hooks.afterMine?.(tx, r);
      return r;
    },
    /** 交易池里的交易按顺序出块 */
    mineQueued() { while (c.queue.length) c.mineItem(c.queue.shift()); },
    opQueued: (from) => BigInt(c.queue.filter((q) => q.kind === 'op' && q.from === from).length),

    async ownerSend(tx) {
      c.ownerTxs.push(tx);
      if (c.hooks.ownerSend) return c.hooks.ownerSend(tx);
      const hash = bytesToHex(keccak256(new TextEncoder().encode('owner:' + c.ownerTxs.length)));
      c.owner.pending += 1n;
      const item = { kind: 'owner', hash, tx };
      if (c.holdOwner) c.queue.push(item);
      else c.mineItem(item);
      // 钱包已经广播了，却没把哈希交回来
      if (c.hooks.ownerThrows?.(tx)) throw new Error('钱包窗口关掉了');
      return hash;
    },
    async sendRaw(raw) {
      c.sent.push(raw);
      const hash = hashOf(raw);
      if (c.receipts.has(hash)) return { known: true, reason: 'nonceUsed' };
      if (c.queue.some((q) => q.hash === hash)) return { known: true, reason: 'pending' };
      if (c.hooks.failSend?.(raw)) throw new Error('network down');
      const tx = decodeRaw(raw);
      const from = c.opAddr();
      const nonce = (c.nonces.get(from) ?? 0n) + c.opQueued(from);
      if (tx.nonce < nonce) return { known: true, reason: 'nonceUsed' };
      if (tx.nonce > nonce) throw new RpcError('nonce too high', -32000);
      if (c.bal(from) < tx.gas * tx.gasPrice) throw new RpcError('insufficient funds for gas * price + value', -32000);
      const item = { kind: 'op', hash, tx, from };
      if (c.holdOps) c.queue.push(item);
      else c.mineItem(item);
      // 节点可能对已经上链的交易报 nonce too low
      const over = c.hooks.sendResult?.(hash);
      return over === undefined ? hash : over;
    },
    async receipt(hash) {
      if (c.hooks.receipt) {
        const v = c.hooks.receipt(hash);
        if (v !== undefined) return v;
      }
      return c.receipts.get(hash) ?? null;
    },
    async nonceOf(a) {
      if (lower(a) === lower(c.circuit.owner)) return { latest: c.owner.latest, pending: c.owner.pending, nodes: 2 };
      const n = c.nonces.get(lower(a)) ?? 0n;
      return { latest: n, pending: n + c.opQueued(lower(a)), nodes: 2 };
    },
    async nativeBalance(a, block) {
      c.calls.push(['nativeBalance', block]);
      return c.bal(a, c.at(block));
    },
    async pinBlock() { return '0x' + (c.head - c.lag).toString(16); },
    async gasPrice() { return PRICE; },
    async openFee() { return FEE; },
    async circuitInfos(list, block) {
      c.calls.push(['circuitInfos', block]);
      const s = c.at(block);
      return [{ exists: true, owner: s.circuit.owner, container: CONTAINER, opened: s.circuit.opened }];
    },
    async isDeployed(circuits, tokenId, block) { return c.at(block).circuit.deployed; },
    async fileInfos(pairs, block) {
      const s = c.at(block);
      return pairs.map(({ path }) => {
        const f = s.files.get(path);
        if (!f) return null;
        return { size: f.chunks.reduce((n, x) => n + x.length, 0), contentType: f.contentType, sha256: f.sha256, updatedAt: 1, chunkCount: f.chunks.length };
      });
    },
    async operatorState(container, operator, block) {
      c.calls.push(['operatorState', block]);
      const s = c.at(block);
      return { canEdit: c.canEdit(operator, s), until: s.grant.until };
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
  let chain;
  // sleep 不真的等，只拨时钟；测试可以在这时让交易出块
  const sleep = async (ms) => { clock.sleeps++; clock.t += ms; chain.hooks.onSleep?.(); };
  const now = () => clock.t;
  const store = createOperatorStore({ dir, encrypt, decrypt, now });
  chain = fakeChain({ clock, store, opened });
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
const opens = (chain) => ownerKinds(chain).filter((k) => k === 'open').length;
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
    // 前两次（inspect、run 开始时的重新检查）在开通之前
    const later = s.chain.calls.filter(([n]) => n === 'circuitInfos').slice(2);
    assert.ok(later.length > 0 && later.every(([, b]) => BigInt(b) >= openBlock));
  } finally { s.done(); }
});

test('开通交易回执 status 0：抛出开通容器失败', async () => {
  const s = setup({ opened: false, files: threeFiles() });
  try {
    s.chain.hooks.revertOwner = (tx) => tx.data.startsWith(SEL.open);
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /开通容器失败/);
  } finally { s.done(); }
});

test('inspect 之后容器已经被开通：run 开始时重新检查，不再交开通费', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    const inspected = await s.p.inspect({ target });
    s.chain.circuit.opened = true;
    s.chain.circuit.deployed = true;
    const r = await s.p.run(inspected);
    assert.equal(r.stage, 'uploaded');
    assert.equal(opens(s.chain), 0);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
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
      s.chain.head += 1n;
      s.chain.receipts.set(hash, { transactionHash: hash, status: 1, blockNumber: s.chain.head, gasUsed: 21000n, effectiveGasPrice: PRICE });
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

// ---- 持有人交易的在途记录、钉住区块读余额（审查 C1 / C2 / I3 / I5 / M7） ----


test('钱包广播了开通交易却抛错：再 run 不会再发一次开通（nonce 检查拦下），上链后接着发布', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    s.chain.holdOwner = true;
    s.chain.hooks.ownerThrows = (tx) => tx.data.startsWith(SEL.open);
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /钱包窗口关掉了/);
    s.chain.hooks.ownerThrows = null;
    // 开通交易还在交易池里：链上看还没开通
    const again = await s.p.inspect({ target });
    assert.equal(again.opened, false);
    await assert.rejects(s.make().run(again), /钱包里还有一笔未确认的交易，请等它确认后再继续/);
    assert.equal(opens(s.chain), 1);

    s.chain.mineQueued();
    s.chain.holdOwner = false;
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.equal(opens(s.chain), 1);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('开通交易等确认超时：记录留在 ownerPending；下次 run 先等它确认，不重发', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    s.chain.holdOwner = true;
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /持有人的交易还没确认，可以稍后继续/);
    const op = s.store.get(BSC.chainId, CONTAINER);
    assert.equal(op.ownerPending.kind, 'open');
    assert.equal(op.ownerPending.hash, s.chain.queue[0].hash);

    // 下次 run 时它才出块
    s.chain.hooks.onSleep = () => s.chain.mineQueued();
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.equal(opens(s.chain), 1);
    assert.equal(s.store.get(BSC.chainId, CONTAINER).ownerPending, null);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('临时钱包在任何持有人交易之前就建好，持有人交易发出时 ownerPending 已落盘', async () => {
  const s = setup({ opened: false, files: threeFiles() });
  try {
    const seen = [];
    s.chain.hooks.ownerSend = async (tx) => {
      seen.push(s.store.get(BSC.chainId, CONTAINER));
      throw new Error('用户拒绝');
    };
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /用户拒绝/);
    assert.equal(seen.length, 1);
    assert.ok(seen[0], '开通之前就有临时钱包记录');
    // 钱包没给哈希：没有可记的 ownerPending
    assert.equal(s.store.get(BSC.chainId, CONTAINER).ownerPending, null);
  } finally { s.done(); }
});

test('开通确认后中断；下次 latest 落后几个块：不会再交一次开通费', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    const signal = { aborted: false };
    const r1 = await s.p.run(await s.p.inspect({ target }), { signal, onProgress: (e) => { if (e.stage === 'open') signal.aborted = true; } });
    assert.deepEqual(r1, { stage: 'paused' });
    assert.equal(s.chain.circuit.opened, true);

    s.chain.lag = 5n;
    const stale = await s.p.inspect({ target });
    assert.equal(stale.opened, false);
    const r2 = await s.make().run(stale);
    assert.equal(r2.stage, 'uploaded');
    assert.equal(opens(s.chain), 1);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('充值确认后 latest 落后：余额钉在最近确认的区块上读，不会再充一次', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    s.chain.lag = 3n;
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
    const reads = s.chain.calls.filter(([n]) => n === 'nativeBalance');
    assert.ok(reads.length >= 4);
    assert.ok(reads.every(([, b]) => typeof b === 'string' && b.startsWith('0x')));
  } finally { s.done(); }
});

test('广播报 nonce too low、回执节点又落后：等到回执，这一笔照样算进上传', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    let target0 = null;
    let calls = 0;
    s.chain.hooks.sendResult = (hash) => {
      if (target0) return undefined;
      target0 = hash;
      return { known: true, reason: 'nonceUsed' };
    };
    // 临时钱包内部查到了回执，紧接着的那次查询落在落后的节点上
    s.chain.hooks.receipt = (hash) => (hash === target0 && ++calls === 2 ? null : undefined);
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.equal(r.uploaded, 4);
    assert.equal(r.spent, spentOf(uploads(s.chain)));
    assert.ok(calls >= 3);
  } finally { s.done(); }
});

test('上传途中授权快到期：重新检查时重新授权', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    let jumped = false;
    s.chain.hooks.afterMine = () => {
      if (jumped) return;
      jumped = true;
      // 第一笔上传之后只剩 100 秒
      s.clock.t += (OPERATOR_TTL - 100) * 1000;
    };
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.deepEqual(ownerKinds(s.chain).filter((k) => k === 'grant').length, 2);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('上次留下的上传 pending：回执没有 effectiveGasPrice 时按签名时记下的 gasPrice 算花费', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    let failed = false;
    s.chain.hooks.failSend = () => (failed ? false : (failed = true));
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /network down/);
    const pending = s.store.get(BSC.chainId, CONTAINER).pending;
    assert.equal(pending.gasPrice, PRICE);
    s.chain.hooks.receipt = (hash) => {
      const r = s.chain.receipts.get(hash);
      return hash === pending.hash && r ? { ...r, effectiveGasPrice: null } : undefined;
    };
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'uploaded');
    assert.equal(r.uploaded, 4);
    assert.equal(r.spent, spentOf(uploads(s.chain)));
  } finally { s.done(); }
});

test('上次留下的上传 pending 回执 status 0：报出那一块失败', async () => {
  const s = setup({ files: threeFiles() });
  try {
    let failed = false;
    s.chain.hooks.failSend = () => (failed ? false : (failed = true));
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /network down/);
    s.chain.hooks.revert = () => true;
    await assert.rejects(s.make().run(await s.p.inspect({ target })), /上传 a\.js 第 0 块失败/);
  } finally { s.done(); }
});

test('持有人交易回执 status 0：清掉 ownerPending 再报错', async () => {
  const s = setup({ opened: false, files: threeFiles() });
  try {
    s.chain.hooks.revertOwner = (tx) => tx.data.startsWith(SEL.open);
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /开通容器失败/);
    assert.equal(s.store.get(BSC.chainId, CONTAINER).ownerPending, null);
  } finally { s.done(); }
});
