// 发布测试共用的有状态假链（publisher-run / publish-service 两边都用）：电路、容器文件、授权、余额、nonce、回执都在内存里。
// 不以 .test.mjs 结尾，npm test 不会把它当测试跑。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublisher } from '../../src/main/publisher.js';
import { createOperatorStore } from '../../src/main/operator-store.js';
import { SEL, BSC } from '../../src/main/config.js';
import { hexToBytes, bytesToHex, decodeResult } from '../../src/main/abi.js';
import { keccak256 } from '../../src/main/keccak.js';
import { RpcError } from '../../src/main/rpc.js';
export const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
export const file = (path, size, fill = 1) => { const bytes = new Uint8Array(size).fill(fill); return { path, bytes, sha256: sha(bytes) }; };

export const OWNER = '0x' + '1'.repeat(40);
export const CONTAINER = '0x' + '2'.repeat(40);
export const CIRCUITS = '0x' + '3'.repeat(40);
export const target = { circuits: CIRCUITS, tokenId: 7, cpu: '#7', label: 'demo' };
export const FEE = 5000000000000000n;
export const PRICE = 50000000n;
export const T0 = 1700000000000;

// 假加密：反转后加前缀
export const encrypt = (s) => Buffer.from('enc:' + [...s].reverse().join(''), 'utf8');
export const decrypt = (buf) => [...Buffer.from(buf).toString('utf8').slice(4)].reverse().join('');
export const hashOf = (raw) => bytesToHex(keccak256(hexToBytes(raw)));
export const lower = (a) => String(a).toLowerCase();
/** 错误带这个 code、message 匹配 re */
export const is = (code, re) => (e) => e.code === code && re.test(e.message);

// 测试用的最小 RLP 解码器（同 operator.test.mjs）
export function rlpItem(b, i) {
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
export const big = (b) => (b.length ? BigInt(bytesToHex(b)) : 0n);
export function decodeRaw(raw) {
  const [[nonce, gasPrice, gas, to, value, data]] = rlpItem(hexToBytes(raw), 0);
  return { nonce: big(nonce), gasPrice: big(gasPrice), gas: big(gas), to: bytesToHex(to), value: big(value), data: bytesToHex(data) };
}

export const args = (data, types) => decodeResult(types, '0x' + data.slice(10));
export const gasOf = (tx) => 21000n + BigInt((tx.data.length - 2) / 2) * 20n;

export const cloneState = (s) => ({
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
export function fakeChain({ clock, store, opened = true, chainId = BSC.chainId }) {
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

export function setup({ opened = true, files: local = [], net = BSC } = {}) {
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
export const content = (chain, path) => Buffer.concat((chain.files.get(path)?.chunks ?? []).map((x) => Buffer.from(x)));
/** 当前的记录；已经退款删掉了就用删之前的最后一份 */
export const recOf = (s) => s.store.get(BSC.chainId, CONTAINER) ?? s.removed.at(-1);
export const sameBytes = (chain, f) => content(chain, f.path).equals(Buffer.from(f.bytes));
export const uploads = (chain) => chain.mined.filter((m) => m.tx.data.startsWith(SEL.putFile) || m.tx.data.startsWith(SEL.appendChunk));
export const ownerKinds = (chain) => chain.ownerTxs.map((tx) => (tx.data === '0x' ? 'fund' : tx.data.startsWith(SEL.open) ? 'open' : tx.data.startsWith(SEL.setOperator) ? 'grant' : '?'));
export const opens = (chain) => ownerKinds(chain).filter((k) => k === 'open').length;
export const spentOf = (mined) => mined.reduce((n, m) => n + m.receipt.gasUsed * m.receipt.effectiveGasPrice, 0n);
