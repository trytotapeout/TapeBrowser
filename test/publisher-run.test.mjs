import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublisher } from '../src/main/publisher.js';
import { createOperatorStore } from '../src/main/operator-store.js';
import { SEL, BSC, XLAYER, CHUNK_BYTES, OPERATOR_TTL, MAX_GAS_PRICE } from '../src/main/config.js';
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
/** 错误带这个 code、message 匹配 re */
const is = (code, re) => (e) => e.code === code && re.test(e.message);

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
  ownerNonce: s.owner.latest,
  owner: { ...s.owner },
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
function fakeChain({ clock, store, opened = true, chainId = BSC.chainId }) {
  const c = {
    head: 100n, lag: 0n, snaps: new Map(),
    circuit: { owner: OWNER, opened, deployed: opened },
    files: new Map(), grant: { operator: null, until: 0 }, balances: new Map(),
    nonces: new Map(), owner: { latest: 0n, pending: 0n }, queue: [], holdOwner: false, holdOps: false,
    receipts: new Map(), txNonces: new Map(), sent: [], mined: [], ownerTxs: [], calls: [], hooks: {},
    // safeLag：safe 区块比链头落后几块；safe 为 false 时节点不支持 safe 标签（safeBlock 返回 null）
    safeLag: 0n, safe: true,
    // 合约地址（eth_getCode 不是 0x）和给它转账的估算 gas；corrupt 里的路径读回来时内容被改了一个字节
    code: new Set(), transferGas: new Map(), corrupt: new Set(),
    nowSec: () => Math.floor(clock.t / 1000),
    opAddr: () => store.get(chainId, CONTAINER)?.address,
    canEdit: (who, s = c) => lower(who) === lower(s.circuit.owner)
      || (s.grant.operator && lower(who) === lower(s.grant.operator) && s.grant.until > c.nowSec()),
    bal: (a, s = c) => s.balances.get(lower(a)) ?? 0n,
    /** 实际用掉的 gas：转给合约地址按 transferGas，其余按 gasOf */
    used: (tx) => (tx.data === '0x' && c.code.has(lower(tx.to)) ? c.transferGas.get(lower(tx.to)) ?? 21000n : gasOf(tx)),

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
        c.balances.set(lower(from), c.bal(from) - tx.value);
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
      const r = { transactionHash: hash, status: ok ? 1 : 0, blockNumber: c.head, gasUsed: c.used(tx), effectiveGasPrice: price };
      c.receipts.set(hash, r);
      return r;
    },
    mineItem(item) {
      if (item.kind === 'owner') {
        // 先出块（快照是出块前的状态，nonce 还没前进），再推进持有人的 nonce
        const r = c.mineTx(item.hash, item.tx.from, item.tx, PRICE, { revert: Boolean(c.hooks.revertOwner?.(item.tx)) });
        c.owner.latest += 1n;
        return r;
      }
      const { hash, tx, from } = item;
      c.nonces.set(from, (c.nonces.get(from) ?? 0n) + 1n);
      const r = c.mineTx(hash, from, tx, tx.gasPrice, { revert: Boolean(c.hooks.revert?.(tx)), charge: c.used(tx) * tx.gasPrice });
      c.mined.push({ hash, tx, from, receipt: r });
      c.hooks.afterMine?.(tx, r);
      return r;
    },
    /**
     * 持有人在钱包里加速 / 取消了交易池里的那笔：同一个 nonce 换成另一笔交易上链，原来的哈希永远没有回执。
     * make(原交易) 返回替换的交易：加速是原样再发；不给 make 是取消（给自己转 0）
     */
    replaceOwner(make = () => ({ from: OWNER, to: OWNER, value: 0n, data: '0x' })) {
      const i = c.queue.findIndex((q) => q.kind === 'owner');
      assert.ok(i >= 0, '交易池里没有持有人的交易');
      const [old] = c.queue.splice(i, 1);
      const hash = bytesToHex(keccak256(new TextEncoder().encode('replaced:' + old.hash)));
      c.mineItem({ kind: 'owner', hash, tx: make(old.tx) });
      return old;
    },
    /** 交易池里的交易按顺序出块 */
    mineQueued() { while (c.queue.length) c.mineItem(c.queue.shift()); },
    opQueued: (from) => BigInt(c.queue.filter((q) => q.kind === 'op' && q.from === from).length),

    async ownerSend(tx) {
      c.ownerTxs.push(tx);
      if (c.hooks.ownerSend) return c.hooks.ownerSend(tx);
      return c.walletSend(tx);
    },
    /** 钱包照常广播一笔持有人交易（ownerSend 的默认行为），nonce 记在 txNonces 里给 txNonce 查 */
    async walletSend(tx) {
      const hash = bytesToHex(keccak256(new TextEncoder().encode('owner:' + c.ownerTxs.length)));
      c.txNonces.set(hash, c.owner.pending);
      c.owner.pending += 1n;
      const item = { kind: 'owner', hash, tx };
      // holdOwner 可以是 (tx) => bool，只扣住某一种持有人交易
      if (typeof c.holdOwner === 'function' ? c.holdOwner(tx) : c.holdOwner) c.queue.push(item);
      else c.mineItem(item);
      // 钱包已经广播了，却没把哈希交回来
      if (c.hooks.ownerThrows?.(tx)) throw new Error('钱包窗口关掉了');
      return hash;
    },
    /** 持有人在钱包里另发了一笔不相干的交易（给自己转 0），立刻出块，用掉一个 nonce */
    unrelatedOwnerTx() {
      const hash = bytesToHex(keccak256(new TextEncoder().encode('unrelated:' + c.head)));
      c.txNonces.set(hash, c.owner.pending);
      c.owner.pending += 1n;
      return c.mineItem({ kind: 'owner', hash, tx: { from: OWNER, to: OWNER, value: 0n, data: '0x' } });
    },
    /** 交易的 nonce（交易池里的也查得到）；不认得的哈希返回 null */
    async txNonce(hash) {
      c.calls.push(['txNonce', hash]);
      if (c.hooks.txNonce) {
        const v = c.hooks.txNonce(hash);
        if (v !== undefined) return v;
      }
      return c.txNonces.get(hash) ?? null;
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
      if (c.bal(from) < tx.gas * tx.gasPrice + tx.value) throw new RpcError('insufficient funds for gas * price + value', -32000);
      const item = { kind: 'op', hash, tx, from };
      c.lastOp = item;
      // drop(tx)：节点收下了却永远不会打包（比如 X Layer 的 L1 数据费不够），只返回哈希
      if (c.hooks.drop?.(tx)) return hash;
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
    async nonceAt(a, block) {
      c.calls.push(['nonceAt', block]);
      assert.equal(lower(a), lower(c.circuit.owner));
      return c.at(block).ownerNonce;
    },
    /** 出几个空块（别人的交易） */
    mineEmpty(n = 1) { for (let i = 0; i < n; i++) { c.snaps.set(c.head, cloneState(c)); c.head += 1n; } },
    async nonceOf(a) {
      if (lower(a) === lower(c.circuit.owner)) return { latest: c.owner.latest, pending: c.owner.pending };
      const n = c.nonces.get(lower(a)) ?? 0n;
      return { latest: n, pending: n + c.opQueued(lower(a)) };
    },
    async nativeBalance(a, block) {
      c.calls.push(['nativeBalance', block]);
      return c.bal(a, c.at(block));
    },
    async pinBlock() {
      const v = c.hooks.pinBlock?.();
      return v !== undefined ? v : '0x' + (c.head - c.lag).toString(16);
    },
    async gasPrice() { return c.price ?? PRICE; },
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
      // 转账（退款）：不执行，合约地址按 transferGas 返回
      if (tx.data === '0x') return c.transferGas.get(lower(tx.to)) ?? 21000n;
      // 在当前状态上模拟一遍，不留下改动
      const snapshot = new Map([...c.files].map(([k, v]) => [k, { ...v, chunks: [...v.chunks] }]));
      const ok = c.apply(tx.from, tx);
      c.files = snapshot;
      if (!ok) throw new RpcError('execution reverted', 3, '0x08c379a0');
      return gasOf(tx);
    },
    async hasCode(addresses, block) {
      c.calls.push(['hasCode', block]);
      return new Map(addresses.map((a) => [lower(a), c.code.has(lower(a))]));
    },
    async safeBlock() {
      c.calls.push(['safeBlock']);
      return c.safe ? c.head - c.safeLag : null;
    },
    /** 从内存里的容器读回整个文件，和 chain.js 一样核对 SHA-256 */
    async readVerified(container, path, info, block) {
      c.calls.push(['readVerified', path, block]);
      const f = c.at(block).files.get(path);
      const bytes = Buffer.concat((f?.chunks ?? []).map((x) => Buffer.from(x)));
      if (c.corrupt.has(path) && bytes.length) bytes[0] ^= 0xff;
      if (bytes.length !== info.size || sha(bytes) !== info.sha256) throw new Error('SHA-256 校验失败：文件可能还在上传中，或已损坏');
      return new Uint8Array(bytes);
    },
  };
  return c;
}

function setup({ opened = true, files: local = [], net = BSC } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'publisher-run-'));
  const clock = { t: T0, sleeps: 0 };
  let chain;
  // sleep 不真的等，只拨时钟；测试可以在这时让交易出块
  const sleep = async (ms) => { clock.sleeps++; clock.t += ms; chain.hooks.onSleep?.(); };
  const now = () => clock.t;
  const store = createOperatorStore({ dir, encrypt, decrypt, now });
  // 退款后记录会被删掉：删之前留一份，测试还能看最后的状态
  const removed = [];
  const rm = store.remove;
  store.remove = (id, container) => { removed.push(store.get(id, container)); rm(id, container); };
  chain = fakeChain({ clock, store, opened, chainId: net.chainId });
  const make = () => createPublisher({
    chain, net, ownerSend: (tx) => chain.ownerSend(tx), store,
    readFiles: async () => local, precheck: async () => ({ items: [] }), now, sleep,
  });
  const p = make();
  return { dir, clock, store, removed, chain, p, make, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 容器里的文件内容拼起来，和本地字节比较 */
const content = (chain, path) => Buffer.concat((chain.files.get(path)?.chunks ?? []).map((x) => Buffer.from(x)));
/** 当前的记录；已经退款删掉了就用删之前的最后一份 */
const recOf = (s) => s.store.get(BSC.chainId, CONTAINER) ?? s.removed.at(-1);
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
    assert.equal(r.stage, 'done');
    assert.equal(r.container, CONTAINER);
    assert.equal(r.label, 'demo');
    assert.equal(r.uploaded, 4);
    assert.equal(r.reused, 0);
    assert.equal(r.spent, spentOf(up));
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
    assert.equal(s.chain.files.get('big.png').chunks.length, 2);
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
    // 授权给了临时钱包，6 小时
    const op = recOf(s).address;
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
    assert.equal(r.stage, 'done');
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
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('OWNER_TX_FAILED', /开通容器失败/));
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
    assert.equal(r.stage, 'done');
    assert.equal(opens(s.chain), 0);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('持有人的交易一直不确认：超时报错，可以稍后继续', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.hooks.ownerSend = async () => '0x' + 'ee'.repeat(32);
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('LATER', /持有人的交易还没确认，可以稍后继续/));
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
    assert.equal(r2.stage, 'done');
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
    assert.equal(r.stage, 'done');
    assert.equal(r.uploaded, 4);
    assert.equal(s.chain.sent.filter((raw) => raw === pending.raw).length, 2);
    assert.equal(uploads(s.chain)[0].hash, pending.hash);
    assert.equal(uploads(s.chain).length, 4);
    assert.equal(recOf(s).pending, null);
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
    assert.equal(r.stage, 'done');
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
    assert.equal(r.stage, 'done');
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
    assert.equal(r.stage, 'done');
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
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('UPLOAD_FAILED', /上传 big\.png 第 1 块失败/));
    // 回滚的那笔也上了链（扣了 gas），之后不再发
    assert.deepEqual(uploads(s.chain).map((m) => m.receipt.status), [1, 1, 0]);
    assert.equal(s.store.get(BSC.chainId, CONTAINER).pending, null);
  } finally { s.done(); }
});

test('上传途中别人改了容器里的文件：重新检查时停下，错误码 STATE_CHANGED', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.hooks.afterMine = (tx) => {
      if (!tx.data.startsWith(SEL.putFile) || s.chain.files.has('big.png')) return;
      const other = new Uint8Array(10).fill(9);
      s.chain.files.set('big.png', { contentType: 'image/png', sha256: sha(other), chunks: [other] });
    };
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('STATE_CHANGED', /链上状态变了，请重新检查：big\.png/));
  } finally { s.done(); }
});

test('授权快过期（不到 5 分钟）：重新授权', async () => {
  const s = setup({ files: threeFiles() });
  try {
    const op = s.store.create({ chainId: BSC.chainId, container: CONTAINER, owner: OWNER }).address;
    s.chain.grant = { operator: op, until: Math.floor(T0 / 1000) + 100 };
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
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
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('OWNER_TX_FAILED', /授权没有生效/));
  } finally { s.done(); }
});

test('同一个容器并发 run：第二个直接拒绝；第一个结束后可以再 run', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    const inspected = await s.p.inspect({ target });
    const first = s.p.run(inspected);
    await assert.rejects(s.make().run(inspected), is('BUSY', /这个容器正在发布/));
    assert.equal((await first).stage, 'done');
    const again = await s.make().run(await s.p.inspect({ target }));
    assert.equal(again.stage, 'done');
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
    assert.equal(r.stage, 'done');
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
    assert.equal(r.stage, 'done');
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
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('UPLOAD_FAILED', /上传 a\.js 第 0 块模拟失败：.*nope/));
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
    assert.equal(r.stage, 'done');
    assert.equal(uploads(s.chain)[0].tx.gas, fresh.stepGas[0]);
  } finally { s.done(); }
});

test('gas 单价太高：上传前停下', async () => {
  const s = setup({ files: threeFiles() });
  try {
    const inspected = await s.p.inspect({ target });
    s.chain.gasPrice = async () => 200000000n;
    await assert.rejects(s.p.run(inspected), is('GAS_PRICE', /当前 Gas 单价太高/));
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
    await assert.rejects(s.make().run(again), is('WALLET_PENDING', /钱包里还有一笔未确认的交易，请等它确认后再继续/));
    assert.equal(opens(s.chain), 1);

    s.chain.mineQueued();
    s.chain.holdOwner = false;
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    assert.equal(opens(s.chain), 1);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('开通交易等确认超时：记录留在 ownerPending；下次 run 先等它确认，不重发', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    s.chain.holdOwner = true;
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('LATER', /持有人的交易还没确认，可以稍后继续/));
    const op = s.store.get(BSC.chainId, CONTAINER);
    assert.equal(op.ownerPending.kind, 'open');
    assert.equal(op.ownerPending.hash, s.chain.queue[0].hash);

    // 下次 run 时它才出块
    s.chain.hooks.onSleep = () => s.chain.mineQueued();
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    assert.equal(opens(s.chain), 1);
    assert.equal(recOf(s).ownerPending, null);
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
    assert.equal(r2.stage, 'done');
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
    assert.equal(r.stage, 'done');
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
    assert.equal(r.stage, 'done');
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
    assert.equal(r.stage, 'done');
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
    assert.equal(r.stage, 'done');
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
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('OWNER_TX_FAILED', /开通容器失败/));
    assert.equal(s.store.get(BSC.chainId, CONTAINER).ownerPending, null);
  } finally { s.done(); }
});

// ---- 持有人在钱包里加速 / 取消了交易（ownerPending 的哈希永远不会上链） ----

/** 第一次 run 停在一笔被扣住的持有人交易上（等确认超时），ownerPending 记下了它 */
async function stuckOn(s, kind, hold) {
  s.chain.holdOwner = hold;
  await assert.rejects(s.p.run(await s.p.inspect({ target })), /持有人的交易还没确认/);
  const p = s.store.get(BSC.chainId, CONTAINER).ownerPending;
  assert.equal(p.kind, kind);
  assert.equal(p.nonce, s.chain.owner.latest);
  s.chain.holdOwner = false;
  return p;
}

test('开通交易被加速（同样的开通换了哈希上链）：下次 run 清掉 ownerPending，重新检查，不再开通', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    await stuckOn(s, 'open', true);
    s.chain.replaceOwner((tx) => tx);
    assert.equal(s.chain.circuit.opened, true);
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    assert.equal(opens(s.chain), 1);
    assert.equal(recOf(s).ownerPending, null);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('开通交易被取消：下次 run 清掉 ownerPending，重新检查，再发一次开通', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    await stuckOn(s, 'open', true);
    s.chain.replaceOwner();
    assert.equal(s.chain.circuit.opened, false);
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    // 第一次那笔被取消了，这次只新发一笔
    assert.equal(opens(s.chain), 2);
    assert.equal(s.chain.circuit.opened, true);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('充值交易被取消：下次 run 按钉住的余额重新算，只再充一次', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    await stuckOn(s, 'fund', (tx) => tx.data === '0x');
    s.chain.replaceOwner();
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund', 'fund']);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('充值交易被加速：下次 run 看到余额已经够了，不再充值', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    await stuckOn(s, 'fund', (tx) => tx.data === '0x');
    s.chain.replaceOwner((tx) => tx);
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
  } finally { s.done(); }
});

test('等确认途中交易被替换：这次 run 就清掉 ownerPending，按链上状态继续', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    s.chain.holdOwner = (tx) => tx.data.startsWith(SEL.open);
    let polls = 0;
    s.chain.hooks.onSleep = () => {
      if (++polls === 3) { s.chain.holdOwner = false; s.chain.replaceOwner((tx) => tx); }
    };
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    assert.equal(opens(s.chain), 1);
    assert.equal(recOf(s).ownerPending, null);
  } finally { s.done(); }
});

test('确认框开着时用户在钱包里另发了一笔：按这笔真正的 nonce 记，不误判成被替换，不再充一次值', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    s.chain.holdOwner = (tx) => tx.data === '0x';
    // 不相干的那笔用掉 nonce N，我们的充值用 N + 1，在交易池里等几轮才出块
    s.chain.hooks.ownerSend = async (tx) => {
      if (tx.data === '0x') s.chain.unrelatedOwnerTx();
      return s.chain.walletSend(tx);
    };
    let polls = 0;
    s.chain.hooks.onSleep = () => { if (++polls === 3) { s.chain.holdOwner = false; s.chain.mineQueued(); } };
    const events = [];
    const r = await s.p.run(await s.p.inspect({ target }), { onProgress: (e) => events.push(e) });
    assert.equal(r.stage, 'done');
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
    assert.ok(!events.some((e) => e.replaced));
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('节点一时还不认得刚发的持有人交易：多查几次，记下它真正的 nonce', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.holdOwner = (tx) => tx.data === '0x';
    s.chain.hooks.ownerSend = async (tx) => {
      if (tx.data === '0x') s.chain.unrelatedOwnerTx();
      return s.chain.walletSend(tx);
    };
    let misses = 2;
    s.chain.hooks.txNonce = () => (misses-- > 0 ? null : undefined);
    const seen = [];
    const set = s.store.setOwnerPending;
    s.store.setOwnerPending = (id, c, p) => { seen.push(p); set(id, c, p); };
    s.chain.hooks.onSleep = () => { if (seen.some((p) => p.kind === 'fund')) { s.chain.holdOwner = false; s.chain.mineQueued(); } };
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    // grant 用 nonce 0，不相干的那笔用 1，充值用 2
    assert.equal(seen.find((p) => p.kind === 'fund').nonce, 2n);
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
  } finally { s.done(); }
});

test('一直查不到持有人交易的 nonce：退回发之前读到的 latest', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.hooks.txNonce = () => null;
    const seen = [];
    const set = s.store.setOwnerPending;
    s.store.setOwnerPending = (id, c, p) => { seen.push(p); set(id, c, p); };
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    assert.deepEqual(seen.map((p) => [p.kind, p.nonce]), [['grant', 0n], ['fund', 1n]]);
  } finally { s.done(); }
});

test('钱包返回的哈希格式不对：等交易池里看得到它再报错；下次 run 被 nonce 检查拦下，不会再充一次', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.holdOwner = (tx) => tx.data === '0x';
    s.chain.hooks.ownerSend = async (tx) => {
      if (tx.data !== '0x') return s.chain.walletSend(tx);
      // 钱包广播了，但交易池要过一会儿才在节点上看得到
      const hash = await s.chain.walletSend(tx);
      s.chain.owner.pending -= 1n;
      s.chain.hooks.onSleep = () => { s.chain.owner.pending = s.chain.owner.latest + 1n; };
      return { hash };
    };
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('BAD_WALLET_HASH', /钱包返回的交易哈希格式不对/));
    assert.equal(s.store.get(BSC.chainId, CONTAINER).ownerPending, null);
    assert.ok(s.chain.owner.pending > s.chain.owner.latest);
    s.chain.hooks = {};
    await assert.rejects(s.make().run(await s.p.inspect({ target })), is('WALLET_PENDING', /钱包里还有一笔未确认的交易，请等它确认后再继续/));
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
  } finally { s.done(); }
});

// ---- 被替换的持有人交易：minBlock 要越过替换它的那笔，落后的节点才不会读到替换之前的状态 ----

/**
 * 节点有快有慢：替换发生之后，钉区块时大多落在还停在替换之前那一块的节点上，
 * 只有 armFresh() 之后的下一次落在已经同步的节点上（run 里检测替换时那一次）
 */
function mixedNodes(s) {
  const stale = '0x' + (s.chain.head - 1n).toString(16);
  let fresh = 0;
  s.chain.hooks.pinBlock = () => {
    if (fresh > 0) { fresh--; return undefined; }
    // 上传确认以后 minBlock 早已越过它，落后的节点不再要紧
    return s.chain.mined.length ? undefined : stale;
  };
  return { armFresh: () => { fresh = 1; } };
}

test('充值被加速、节点有快有慢：替换后 minBlock 前进，余额不早于替换的区块读，不会再充一次', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    await stuckOn(s, 'fund', (tx) => tx.data === '0x');
    s.chain.replaceOwner((tx) => tx);
    const replacedAt = s.chain.head;
    const nodes = mixedNodes(s);
    const inspected = await s.p.inspect({ target });
    assert.ok(BigInt(inspected.block) < replacedAt);
    nodes.armFresh();
    const progress = [];
    const before = s.chain.calls.length;
    const r = await s.make().run(inspected, { onProgress: (e) => progress.push(e) });
    assert.equal(r.stage, 'done');
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
    assert.ok(progress.some((e) => e.stage === 'fund' && e.replaced === true));
    // 只看这次 run 的读取
    const reads = s.chain.calls.slice(before).filter(([n]) => n === 'nativeBalance');
    assert.ok(reads.length > 0 && reads.every(([, b]) => BigInt(b) >= replacedAt), '余额读取不早于替换的区块');
    assert.ok(recOf(s).minBlock >= replacedAt);
  } finally { s.done(); }
});

test('开通被加速、节点有快有慢：不会再发开通交易', async () => {
  const files = threeFiles();
  const s = setup({ opened: false, files });
  try {
    await stuckOn(s, 'open', true);
    s.chain.replaceOwner((tx) => tx);
    const nodes = mixedNodes(s);
    const inspected = await s.p.inspect({ target });
    assert.equal(inspected.opened, false);
    nodes.armFresh();
    const progress = [];
    const r = await s.make().run(inspected, { onProgress: (e) => progress.push(e) });
    assert.equal(r.stage, 'done');
    assert.equal(opens(s.chain), 1);
    assert.ok(progress.some((e) => e.stage === 'open' && e.replaced === true));
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
  } finally { s.done(); }
});

test('钉住的区块还没看到 nonce 被用掉：不清记录，当成还在等', async () => {
  const s = setup({ files: threeFiles() });
  try {
    await stuckOn(s, 'fund', (tx) => tx.data === '0x');
    s.chain.replaceOwner((tx) => tx);
    // latest nonce 已经前进，钉住的区块落后到替换之前
    s.chain.lag = 1n;
    await assert.rejects(s.make().run(await s.p.inspect({ target })), /持有人的交易还没确认/);
    assert.equal(s.store.get(BSC.chainId, CONTAINER).ownerPending.kind, 'fund');
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
  } finally { s.done(); }
});

// ---- 核验和退款 ----

const OLD = '0x' + '4'.repeat(40);
const refunds = (chain) => chain.mined.filter((m) => m.tx.data === '0x');
const funded = (chain) => chain.ownerTxs.filter((tx) => tx.data === '0x').reduce((n, tx) => n + tx.value, 0n);

/** 给 who 建一条临时钱包记录，钱包里放 balance */
function oldWallet(s, who, balance) {
  const rec = s.store.create({ chainId: BSC.chainId, container: CONTAINER, owner: who });
  s.chain.balances.set(rec.address, balance);
  return rec;
}

test('完整发布：核验通过，余额减去 21000 × gasPrice 退回持有人，记录删掉', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    assert.equal(r.verified, true);
    assert.equal(r.safeSkipped, false);
    assert.equal(r.dust, false);
    const [back] = refunds(s.chain);
    assert.equal(back.receipt.status, 1);
    assert.equal(lower(back.tx.to), lower(OWNER));
    assert.equal(back.tx.gas, 21000n);
    assert.equal(r.refunded, funded(s.chain) - spentOf(uploads(s.chain)) - 21000n * PRICE);
    assert.equal(back.tx.value, r.refunded);
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
    // 每个文件都读回来核对过；没有撤销授权
    const read = s.chain.calls.filter(([n]) => n === 'readVerified').map(([, p]) => p).sort();
    assert.deepEqual(read, ['a.js', 'big.png', 'index.html']);
    assert.deepEqual(ownerKinds(s.chain), ['grant', 'fund']);
  } finally { s.done(); }
});

test('核验对不上：先退款，再抛出核验失败', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.corrupt.add('big.png');
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('VERIFY_FAILED', /核验失败：big\.png/));
    assert.equal(refunds(s.chain).length, 1);
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
  } finally { s.done(); }
});

test('X Layer：等 safe 区块覆盖最后一笔交易再核验', async () => {
  const s = setup({ files: threeFiles(), net: XLAYER });
  try {
    s.chain.safeLag = 3n;
    s.chain.hooks.onSleep = () => { if (s.chain.safeLag > 0n) s.chain.safeLag -= 1n; };
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.verified, true);
    assert.equal(r.safeSkipped, false);
    assert.ok(s.chain.calls.filter(([n]) => n === 'safeBlock').length >= 4);
    // 核验在 safe 追上之后才开始
    const firstRead = s.chain.calls.findIndex(([n]) => n === 'readVerified');
    const lastSafe = s.chain.calls.findLastIndex(([n]) => n === 'safeBlock');
    assert.ok(lastSafe < firstRead);
  } finally { s.done(); }
});

test('X Layer 节点不支持 safe：跳过等待，照常核验，结果里注明 safeSkipped', async () => {
  const s = setup({ files: threeFiles(), net: XLAYER });
  try {
    s.chain.safe = false;
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.verified, true);
    assert.equal(r.safeSkipped, true);
  } finally { s.done(); }
});

test('X Layer safe 区块一直追不上：超时不核验，照样退款', async () => {
  const s = setup({ files: threeFiles(), net: XLAYER });
  try {
    s.chain.safeLag = 1000n;
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    assert.equal(r.verified, false);
    assert.equal(r.reason, 'safe');
    assert.equal(s.chain.calls.filter(([n]) => n === 'readVerified').length, 0);
    assert.equal(refunds(s.chain).length, 1);
    assert.equal(s.store.get(XLAYER.chainId, CONTAINER), null);
  } finally { s.done(); }
});

test('持有人是合约：退款 gas 用 estimateGas × 1.25', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.code.add(lower(OWNER));
    s.chain.transferGas.set(lower(OWNER), 30000n);
    const r = await s.p.run(await s.p.inspect({ target }));
    const [back] = refunds(s.chain);
    assert.equal(back.tx.gas, 37500n);
    assert.equal(r.refunded, funded(s.chain) - spentOf(uploads(s.chain)) - 37500n * PRICE);
    // 实际只用了 30000，多留的手续费还在钱包里，记录保留
    assert.equal(s.chain.bal(back.from), 7500n * PRICE);
    assert.ok(s.store.get(BSC.chainId, CONTAINER));
  } finally { s.done(); }
});

test('余额不够付退款手续费：不发交易，保留记录，返回 dust', async () => {
  const s = setup();
  try {
    oldWallet(s, OWNER, 21000n * PRICE - 1n);
    const r = await s.p.refund({ chainId: BSC.chainId, container: CONTAINER });
    assert.deepEqual(r, { refunded: 0n, dust: true });
    assert.equal(refunds(s.chain).length, 0);
    assert.ok(s.store.get(BSC.chainId, CONTAINER));
  } finally { s.done(); }
});

test('单独 refund：退回记录里的持有人（电路已经转给别人了也一样），删除记录', async () => {
  const s = setup();
  try {
    await assert.rejects(s.p.refund({ chainId: BSC.chainId, container: CONTAINER }), is('NO_OPERATOR', /没有这个容器的临时钱包/));
    oldWallet(s, OLD, 10n ** 15n);
    const r = await s.p.refund({ chainId: BSC.chainId, container: CONTAINER });
    assert.deepEqual(r, { refunded: 10n ** 15n - 21000n * PRICE, dust: false });
    const [back] = refunds(s.chain);
    assert.equal(lower(back.tx.to), lower(OLD));
    assert.equal(s.chain.bal(OLD), r.refunded);
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
  } finally { s.done(); }
});

test('退款回执 status 0：抛出退款失败，保留记录', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.hooks.revert = (tx) => tx.data === '0x';
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('REFUND_FAILED', /退款失败/));
    const rec = s.store.get(BSC.chainId, CONTAINER);
    assert.ok(rec);
    assert.equal(rec.pending, null);
  } finally { s.done(); }
});

test('电路换了持有人：旧临时钱包的余额先退给旧持有人，再为新持有人新建，发布完成', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    const old = oldWallet(s, OLD, 10n ** 15n);
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    const [first, second] = refunds(s.chain);
    assert.equal(first.from, old.address);
    assert.equal(lower(first.tx.to), lower(OLD));
    assert.equal(s.chain.bal(OLD), 10n ** 15n - 21000n * PRICE);
    // 新钱包是另一个地址，退款回到新持有人
    assert.notEqual(second.from, old.address);
    assert.equal(lower(second.tx.to), lower(OWNER));
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
  } finally { s.done(); }
});

test('电路换了持有人、旧临时钱包只剩一点：报错，保留旧记录，什么都不发', async () => {
  const s = setup({ files: threeFiles() });
  try {
    const old = oldWallet(s, OLD, 1000n);
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('OLD_OWNER_DUST', /旧持有人的临时钱包余额不够付退款手续费，已保留记录/));
    assert.equal(s.store.get(BSC.chainId, CONTAINER).address, old.address);
    assert.equal(s.chain.mined.length, 0);
    assert.equal(s.chain.ownerTxs.length, 0);
  } finally { s.done(); }
});

// ---- 放弃旧持有人钱包里退不出来的零头 ----

const discard = (s) => s.p.discardDust({ chainId: BSC.chainId, container: CONTAINER });

test('discardDust：余额不够付退款手续费，删掉记录，返回放弃的余额', async () => {
  const s = setup();
  try {
    oldWallet(s, OLD, 21000n * PRICE);
    assert.deepEqual(await discard(s), { discarded: 21000n * PRICE });
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
    assert.equal(s.chain.mined.length, 0);
    // 删掉以后可以为新持有人新建
    const r = await s.p.run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
  } finally { s.done(); }
});

test('discardDust：余额还能退回就拒绝，记录保留', async () => {
  const s = setup();
  try {
    oldWallet(s, OLD, 21000n * PRICE + 1n);
    await assert.rejects(discard(s), is('NOT_DUST', /临时钱包里的余额还能退回，请先退款/));
    assert.ok(s.store.get(BSC.chainId, CONTAINER));
  } finally { s.done(); }
});

test('discardDust：持有人是合约时按估算的退款 gas 判断', async () => {
  const s = setup();
  try {
    s.chain.code.add(lower(OLD));
    s.chain.transferGas.set(lower(OLD), 40000n);
    // 按 21000 算能退，按合约的 40000 × 1.25 算退不出来
    oldWallet(s, OLD, 30000n * PRICE);
    assert.deepEqual(await discard(s), { discarded: 30000n * PRICE });
  } finally { s.done(); }
});

test('discardDust：有在途交易、持有人钱包有未确认的交易、没有记录、正在发布时都拒绝', async () => {
  const s = setup();
  try {
    await assert.rejects(discard(s), is('NO_OPERATOR', /没有这个容器的临时钱包/));
    const rec = oldWallet(s, OWNER, 1n);
    s.store.setPending(BSC.chainId, CONTAINER, { raw: '0x01', hash: '0x02', kind: 'refund', nonce: 0n, value: 0n });
    await assert.rejects(discard(s), is('LATER', /临时钱包还有一笔交易在等确认/));
    s.store.clearPending(BSC.chainId, CONTAINER);
    s.store.setOwnerPending(BSC.chainId, CONTAINER, { kind: 'fund', hash: '0x' + 'e'.repeat(64), at: T0, nonce: 0n });
    await assert.rejects(discard(s), is('LATER', /持有人还有一笔交易在等确认/));
    s.store.clearOwnerPending(BSC.chainId, CONTAINER);
    s.chain.owner.pending = s.chain.owner.latest + 1n;
    await assert.rejects(discard(s), is('WALLET_PENDING', /持有人钱包里还有一笔未确认的交易/));
    s.chain.owner.pending = s.chain.owner.latest;
    assert.equal(s.store.get(BSC.chainId, CONTAINER).address, rec.address);
    await assert.rejects(s.p.discardDust({ chainId: 1, container: CONTAINER }), is('CHAIN_MISMATCH', /网络不一致/));
    // 和 refund / run 共用容器锁
    const busy = s.p.refund({ chainId: BSC.chainId, container: CONTAINER });
    await assert.rejects(discard(s), is('BUSY', /这个容器正在发布/));
    await busy;
  } finally { s.done(); }
});

test('discardDust：余额不早于 pinBlock 读，刚到账的充值看得到', async () => {
  const s = setup();
  try {
    const rec = oldWallet(s, OLD, 0n);
    s.store.setMinBlock(BSC.chainId, CONTAINER, s.chain.head);
    s.chain.mineTx('0x' + 'f'.repeat(64), OWNER, { from: OWNER, to: rec.address, value: 10n ** 15n, data: '0x' }, PRICE);
    s.chain.mineEmpty(1);
    await assert.rejects(discard(s), is('NOT_DUST', /请先退款/));
  } finally { s.done(); }
});

test('refund 和 run 共用容器锁', async () => {
  const s = setup({ files: threeFiles() });
  try {
    const running = s.p.run(await s.p.inspect({ target }));
    await assert.rejects(s.p.refund({ chainId: BSC.chainId, container: CONTAINER }), is('BUSY', /这个容器正在发布/));
    assert.equal((await running).stage, 'done');
  } finally { s.done(); }
});

// ---- 退款不会把钱卡住 ----

/** 节点的最低单价涨到 2 × PRICE：按 PRICE 签的退款永远不会打包（重发也一样），按新单价重签的才会 */
function dropCheap(s) {
  s.chain.hooks.drop = (tx) => {
    if (tx.data !== '0x' || tx.gasPrice >= 2n * PRICE) return false;
    s.chain.price = 2n * PRICE;
    return true;
  };
}

test('单独 refund：持有人钱包里还有未确认的交易（可能是一笔充值）就不退，记录保留', async () => {
  const s = setup();
  try {
    oldWallet(s, OWNER, 10n ** 15n);
    s.chain.owner.pending = s.chain.owner.latest + 1n;
    await assert.rejects(s.p.refund({ chainId: BSC.chainId, container: CONTAINER }), is('WALLET_PENDING', /持有人钱包里还有一笔未确认的交易，等它确认后再退款/));
    assert.ok(s.store.get(BSC.chainId, CONTAINER));
    assert.equal(s.chain.mined.length, 0);
  } finally { s.done(); }
});

test('单独 refund：余额不早于 pinBlock 读；刚确认的充值在 rec.minBlock 上看不到也不会删记录', async () => {
  const s = setup();
  try {
    const rec = oldWallet(s, OWNER, 0n);
    s.store.setMinBlock(BSC.chainId, CONTAINER, s.chain.head);
    // 充值刚刚上链：在 rec.minBlock 上余额还是 0，在 latest（落后一块的节点也能看到的块）上有钱
    s.chain.mineTx('0x' + 'f'.repeat(64), OWNER, { from: OWNER, to: rec.address, value: 10n ** 15n, data: '0x' }, PRICE);
    s.chain.mineEmpty(1);
    s.chain.lag = 1n;
    const pinned = s.chain.head - 1n;
    const before = s.chain.bal(OWNER);
    const r = await s.p.refund({ chainId: BSC.chainId, container: CONTAINER });
    assert.deepEqual(r, { refunded: 10n ** 15n - 21000n * PRICE, dust: false });
    const reads = s.chain.calls.filter(([n]) => n === 'nativeBalance');
    assert.ok(reads.length && BigInt(reads[0][1]) >= pinned);
    assert.equal(s.chain.bal(OWNER) - before, r.refunded);
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
  } finally { s.done(); }
});

test('退款交易节点一直不打包：同一个 nonce、按当前单价重算金额重签，确认后删除记录', async () => {
  const s = setup();
  try {
    const rec = oldWallet(s, OWNER, 10n ** 15n);
    dropCheap(s);
    const r = await s.p.refund({ chainId: BSC.chainId, container: CONTAINER });
    const raws = s.chain.sent.map(decodeRaw).filter((t) => t.data === '0x');
    const [first, second] = [raws[0], raws.at(-1)];
    assert.equal(first.nonce, second.nonce);
    assert.ok(second.value < first.value);
    assert.equal(refunds(s.chain).length, 1);
    assert.equal(refunds(s.chain)[0].tx.value, second.value);
    assert.deepEqual(r, { refunded: second.value, dust: false });
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
    assert.equal(s.chain.bal(rec.address), 0n);
  } finally { s.done(); }
});

test('X Layer 重签退款：多留 20% 手续费不退', async () => {
  const s = setup({ net: XLAYER });
  try {
    const rec = s.store.create({ chainId: XLAYER.chainId, container: CONTAINER, owner: OWNER });
    s.chain.balances.set(rec.address, 10n ** 15n);
    dropCheap(s);
    const r = await s.p.refund({ chainId: XLAYER.chainId, container: CONTAINER });
    assert.deepEqual(r, { refunded: 10n ** 15n - 21000n * 2n * PRICE * 12n / 10n, dust: false });
    // 留下的那一点在钱包里，记录保留
    assert.ok(s.store.get(XLAYER.chainId, CONTAINER));
  } finally { s.done(); }
});

test('上次崩溃留下的退款 pending 在开始时确认：refunded 是它的金额', async () => {
  const s = setup();
  try {
    oldWallet(s, OWNER, 10n ** 15n);
    s.chain.hooks.drop = (tx) => tx.data === '0x';
    s.chain.hooks.onSleep = () => { throw new Error('crash'); };
    await assert.rejects(s.p.refund({ chainId: BSC.chainId, container: CONTAINER }), /crash/);
    const p = s.store.get(BSC.chainId, CONTAINER).pending;
    assert.equal(p.kind, 'refund');
    // 重启后节点把它打包了
    s.chain.hooks = {};
    s.chain.mineItem({ kind: 'op', hash: p.hash, tx: decodeRaw(s.chain.sent.at(-1)), from: s.chain.opAddr() });
    const r = await s.make().refund({ chainId: BSC.chainId, container: CONTAINER });
    assert.deepEqual(r, { refunded: p.value, dust: false });
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
  } finally { s.done(); }
});

test('上次崩溃留下的退款 pending 一直不打包：下次 run 重签、确认，算进 refunded，再照常发布', async () => {
  const files = threeFiles();
  const s = setup({ files });
  try {
    oldWallet(s, OWNER, 10n ** 15n);
    s.chain.hooks.drop = (tx) => tx.data === '0x';
    s.chain.hooks.onSleep = () => { throw new Error('crash'); };
    await assert.rejects(s.p.refund({ chainId: BSC.chainId, container: CONTAINER }), /crash/);
    const p = s.store.get(BSC.chainId, CONTAINER).pending;
    assert.equal(p.kind, 'refund');
    // 重启后旧单价的那笔仍然永远不打包，重签的才会
    s.chain.hooks = { drop: (tx) => tx.data === '0x' && tx.nonce === p.nonce && tx.gasPrice === p.gasPrice };
    const r = await s.make().run(await s.p.inspect({ target }));
    assert.equal(r.stage, 'done');
    const [left, back] = refunds(s.chain);
    assert.equal(left.tx.nonce, p.nonce);
    assert.equal(left.tx.gasPrice, PRICE * 1125n / 1000n);
    assert.equal(lower(back.tx.to), lower(OWNER));
    assert.equal(r.refunded, left.tx.value + back.tx.value);
    for (const f of files) assert.ok(sameBytes(s.chain, f), f.path);
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
  } finally { s.done(); }
});

test('核验时节点出错：照样退款，再抛出原来的错误', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.readVerified = async () => { throw new Error('节点超时'); };
    await assert.rejects(s.p.run(await s.p.inspect({ target })), /节点超时/);
    assert.equal(refunds(s.chain).length, 1);
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
  } finally { s.done(); }
});

test('核验出错、退款也出错：抛出核验的错误，退款的错误放在 cause 里', async () => {
  const s = setup({ files: threeFiles() });
  try {
    s.chain.readVerified = async () => { throw new Error('节点超时'); };
    s.chain.hooks.revert = (tx) => tx.data === '0x';
    await assert.rejects(s.p.run(await s.p.inspect({ target })), (e) => /节点超时/.test(e.message) && is('REFUND_FAILED', /退款失败/)(e.cause));
    assert.ok(s.store.get(BSC.chainId, CONTAINER));
  } finally { s.done(); }
});

test('电路换了持有人、上一位持有人的交易还没确认：提示上一位持有人', async () => {
  const s = setup({ files: threeFiles() });
  try {
    oldWallet(s, OLD, 10n ** 15n);
    s.store.setOwnerPending(BSC.chainId, CONTAINER, { kind: 'fund', hash: '0x' + 'e'.repeat(64), at: T0, nonce: 0n });
    await assert.rejects(s.p.run(await s.p.inspect({ target })), is('LATER', /上一位持有人的交易还没确认，可以稍后再试/));
    assert.equal(s.store.get(BSC.chainId, CONTAINER).owner, lower(OLD));
  } finally { s.done(); }
});

test('重签退款要压过旧的那笔：节点单价没变时 gasPrice 提高 12.5%，哈希不同', async () => {
  const s = setup();
  try {
    oldWallet(s, OWNER, 10n ** 15n);
    // 第一笔永远不打包，节点单价不变
    let first = null;
    s.chain.hooks.drop = (tx) => {
      if (tx.data !== '0x') return false;
      first ??= tx;
      return tx.gasPrice === first.gasPrice;
    };
    const r = await s.p.refund({ chainId: BSC.chainId, container: CONTAINER });
    const [back] = refunds(s.chain);
    const bumped = PRICE * 1125n / 1000n;
    assert.equal(first.gasPrice, PRICE);
    assert.equal(back.tx.gasPrice, bumped);
    assert.notEqual(back.hash, hashOf(s.chain.sent.find((raw) => decodeRaw(raw).gasPrice === PRICE)));
    assert.deepEqual(r, { refunded: 10n ** 15n - 21000n * bumped, dust: false });
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
  } finally { s.done(); }
});

test('重签退款：单价已经在上限，没法再压过旧的那笔：报错并保留 pending', async () => {
  const s = setup();
  try {
    oldWallet(s, OWNER, 10n ** 15n);
    s.chain.price = MAX_GAS_PRICE;
    s.chain.hooks.drop = (tx) => tx.data === '0x';
    await assert.rejects(s.p.refund({ chainId: BSC.chainId, container: CONTAINER }), is('GAS_PRICE', /退款交易一直没有打包，Gas 单价已到上限/));
    assert.equal(s.store.get(BSC.chainId, CONTAINER).pending.kind, 'refund');
  } finally { s.done(); }
});

test('重签之后旧版本上链：按旧版本的金额报退款，不报状态异常', async () => {
  const s = setup();
  try {
    oldWallet(s, OWNER, 10n ** 15n);
    let old = null;
    s.chain.hooks.drop = (tx) => {
      if (tx.data !== '0x') return false;
      if (!old) { old = s.chain.lastOp; return true; }
      // 重签的那笔还没打包时，旧的那笔先上链了
      if (s.chain.lastOp.hash !== old.hash && !s.chain.receipts.has(old.hash)) s.chain.mineItem(old);
      return true;
    };
    const r = await s.p.refund({ chainId: BSC.chainId, container: CONTAINER });
    assert.deepEqual(r, { refunded: old.tx.value, dust: false });
    assert.equal(refunds(s.chain).length, 1);
    assert.equal(refunds(s.chain)[0].hash, old.hash);
    assert.equal(s.store.get(BSC.chainId, CONTAINER), null);
  } finally { s.done(); }
});
