import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperatorStore } from '../src/main/operator-store.js';
import { createOperator } from '../src/main/operator.js';
import { uploadTx, refundTx } from '../src/main/publish-tx.js';
import { BSC } from '../src/main/config.js';
import { hexToBytes, bytesToHex } from '../src/main/abi.js';
import { keccak256 } from '../src/main/keccak.js';

const C = '0x3104dccd0000000000000000000000006afff20a';
const OWNER = '0x937a5d2985a94f900e5ab00eaebaf5271d98d743';
const SHA = '0x' + 'ab'.repeat(32);
const step = (index) => ({ path: 'a.js', index, row: { contentType: 'text/javascript; charset=utf-8', sha256: SHA, bytes: new Uint8Array(30000).fill(1) } });
const upload = (index = 0) => ({ ...uploadTx(BSC, C, step(index)), gas: 5000000n, gasPrice: 50000000n });

// 假加密：反转后加前缀
const encrypt = (s) => Buffer.from('enc:' + [...s].reverse().join(''), 'utf8');
const decrypt = (buf) => [...Buffer.from(buf).toString('utf8').slice(4)].reverse().join('');

const hashOf = (raw) => bytesToHex(keccak256(hexToBytes(raw)));

/** 假链：记录每次 sendRaw 的 raw；nonce、回执、广播结果都由测试控制 */
function fakeChain({ latest = 0n, pending } = {}) {
  const c = {
    latest, pending: pending ?? latest, sent: [], receipts: new Map(), sendImpl: null, onNonce: null,
    async nonceOf() {
      if (c.onNonce) c.onNonce();
      return { latest: c.latest, pending: c.pending, nodes: 2 };
    },
    async sendRaw(raw) {
      c.sent.push(raw);
      return c.sendImpl ? c.sendImpl(raw) : hashOf(raw);
    },
    receiptCalls: 0, receiptImpl: null,
    async receipt(hash) {
      c.receiptCalls++;
      return c.receiptImpl ? c.receiptImpl(hash, c.receiptCalls) : c.receipts.get(hash) ?? null;
    },
    async nativeBalance(a, block) { c.balanceOf = a; c.balanceBlock = block; return 123n; },
    /** 让这笔交易上链 */
    mine(hash, status = 1) {
      c.receipts.set(hash, { transactionHash: hash, status, blockNumber: 100n, gasUsed: 21000n, effectiveGasPrice: 50000000n });
      c.latest += 1n;
      c.pending = c.latest;
    },
  };
  return c;
}

function setup(chainOpts) {
  const dir = mkdtempSync(join(tmpdir(), 'operator-'));
  const make = () => createOperatorStore({ dir, encrypt, decrypt, now: () => 1 });
  const store = make();
  store.create({ chainId: BSC.chainId, container: C, owner: OWNER });
  const chain = fakeChain(chainOpts);
  // 假时钟：sleep 不真的等，只把时间往前拨
  const clock = { t: 0, sleeps: 0 };
  const sleep = async (ms) => { clock.sleeps++; clock.t += ms; };
  const now = () => clock.t;
  const op = (s = store) => createOperator({ store: s, chain, net: BSC, container: C, owner: OWNER, sleep, now });
  return { store, make, chain, clock, op, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// 测试用的最小 RLP 解码器（同 eth-tx.test.mjs）
function rlpDecode(b) {
  const [item, end] = rlpItem(b, 0);
  assert.equal(end, b.length);
  return item;
}
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

/** raw → {nonce, gasPrice, gas, to, value, data, chainId} */
function decodeRaw(raw) {
  const [nonce, gasPrice, gas, to, value, data, v] = rlpDecode(hexToBytes(raw));
  return {
    nonce: big(nonce), gasPrice: big(gasPrice), gas: big(gas), to: bytesToHex(to), value: big(value),
    data: bytesToHex(data), chainId: (big(v) - 35n) / 2n,
  };
}

test('正常上传一笔：用 latest 作 nonce，先写 pending 再广播，确认后 lastNonce 前进', async () => {
  const { store, chain, op, done } = setup({ latest: 5n });
  try {
    const o = op();
    assert.equal(o.address, store.get(BSC.chainId, C).address);
    assert.equal(await o.balance(), 123n);
    assert.equal(chain.balanceOf, o.address);
    // 余额可以钉在指定区块读
    assert.equal(await o.balance('0x64'), 123n);
    assert.equal(chain.balanceBlock, '0x64');

    const tx = upload(0);
    // 广播时 pending 必须已经落盘
    let pendingAtSend;
    chain.sendImpl = (raw) => { pendingAtSend = store.get(BSC.chainId, C).pending; return hashOf(raw); };
    const hash = await o.send(tx, { kind: 'upload', path: 'a.js', index: 0 });
    assert.equal(chain.sent.length, 1);
    assert.equal(hash, hashOf(chain.sent[0]));
    assert.equal(pendingAtSend.hash, hash);

    const d = decodeRaw(chain.sent[0]);
    assert.deepEqual(d, { nonce: 5n, gasPrice: 50000000n, gas: 5000000n, to: BSC.registry, value: 0n, data: tx.data, chainId: 56n });

    const p = store.get(BSC.chainId, C).pending;
    // 签名用的 gasPrice 也记下来：回执没有 effectiveGasPrice 时按它算花费
    assert.deepEqual(p, { raw: chain.sent[0], hash, kind: 'upload', path: 'a.js', index: 0, nonce: 5n, gasPrice: 50000000n });

    chain.mine(hash);
    const r = await o.settle();
    assert.deepEqual(r, { hash, status: 1, gasUsed: 21000n, effectiveGasPrice: 50000000n, blockNumber: 100n });
    const rec = store.get(BSC.chainId, C);
    assert.equal(rec.pending, null);
    assert.equal(rec.lastNonce, 5n);
    // 没有 pending 时 settle 返回 null
    assert.equal(await o.settle(), null);
  } finally { done(); }
});

test('退款：转给持有人、不带 data', async () => {
  const { store, chain, op, done } = setup({ latest: 2n });
  try {
    const hash = await op().send({ ...refundTx(OWNER, 1000n), gas: 21000n, gasPrice: 50000000n }, { kind: 'refund' });
    const d = decodeRaw(chain.sent[0]);
    assert.deepEqual([d.nonce, d.to, d.value, d.data, d.chainId], [2n, OWNER, 1000n, '0x', 56n]);
    const p = store.get(BSC.chainId, C).pending;
    assert.equal(p.kind, 'refund');
    assert.equal(p.hash, hash);
    assert.equal('path' in p, false);
  } finally { done(); }
});

test('白名单拒绝时不写 pending、不广播', async () => {
  const { store, chain, op, done } = setup();
  try {
    const o = op();
    await assert.rejects(o.send({ ...upload(0), to: OWNER }, { kind: 'upload' }), /不在允许范围内/);
    // 退款带 data 也不行
    await assert.rejects(o.send({ ...refundTx(OWNER, 1n), data: '0x12', gas: 21000n, gasPrice: 1n }, { kind: 'refund' }), /不在允许范围内/);
    // 上传交易按退款发也不行
    await assert.rejects(o.send(upload(0), { kind: 'refund' }), /不在允许范围内/);
    assert.equal(chain.sent.length, 0);
    assert.equal(store.get(BSC.chainId, C).pending, null);
  } finally { done(); }
});

test('广播失败：pending 保留，send 被拒，settle 重发的是同一笔 raw', async () => {
  const { store, chain, op, done } = setup({ latest: 3n });
  try {
    const o = op();
    chain.sendImpl = () => { throw new Error('网络断了'); };
    await assert.rejects(o.send(upload(0), { kind: 'upload', path: 'a.js', index: 0 }), /网络断了/);
    const p = store.get(BSC.chainId, C).pending;
    assert.ok(p);
    assert.equal(p.raw, chain.sent[0]);

    // 有 pending 时 send 被拒，不读 nonce、不广播
    await assert.rejects(o.send(upload(1), { kind: 'upload', path: 'a.js', index: 1 }), /还有一笔交易在等确认/);
    assert.equal(chain.sent.length, 1);

    // 重发成功后上链
    chain.sendImpl = (raw) => { chain.mine(hashOf(raw)); return hashOf(raw); };
    const r = await o.settle();
    assert.equal(r.hash, p.hash);
    assert.ok(chain.sent.length >= 2);
    assert.ok(chain.sent.every((raw) => raw === p.raw));
    assert.equal(store.get(BSC.chainId, C).pending, null);
    assert.equal(store.get(BSC.chainId, C).lastNonce, 3n);
  } finally { done(); }
});

test('pending > latest 时被拒', async () => {
  const { store, chain, op, done } = setup({ latest: 3n, pending: 4n });
  try {
    await assert.rejects(op().send(upload(0), { kind: 'upload' }), /临时钱包有未确认的交易/);
    assert.equal(chain.sent.length, 0);
    assert.equal(store.get(BSC.chainId, C).pending, null);
  } finally { done(); }
});

test('节点落后（latest <= lastNonce）时被拒', async () => {
  const { store, chain, op, done } = setup({ latest: 5n });
  try {
    store.setLastNonce(BSC.chainId, C, 5n);
    await assert.rejects(op().send(upload(0), { kind: 'upload' }), /节点还没同步到最新区块，请稍后再试/);
    chain.latest = chain.pending = 4n;
    await assert.rejects(op().send(upload(0), { kind: 'upload' }), /节点还没同步到最新区块/);
    assert.equal(chain.sent.length, 0);
    assert.equal(store.get(BSC.chainId, C).pending, null);
    // 追上来之后可以发
    chain.latest = chain.pending = 6n;
    await op().send(upload(0), { kind: 'upload' });
    assert.equal(decodeRaw(chain.sent[0]).nonce, 6n);
  } finally { done(); }
});

test('确认后 lastNonce 前进，重建 store 后还在', async () => {
  const { make, chain, op, done } = setup({ latest: 7n });
  try {
    const hash = await op().send(upload(0), { kind: 'upload' });
    chain.mine(hash);
    await op().settle();
    const s2 = make();
    assert.equal(s2.get(BSC.chainId, C).lastNonce, 7n);
    // 节点回退到旧 nonce：新 store 上的 operator 也会拒绝
    chain.latest = chain.pending = 7n;
    await assert.rejects(op(s2).send(upload(1), { kind: 'upload' }), /节点还没同步/);
  } finally { done(); }
});
test('sendRaw 返回 nonceUsed、回执显示就是这笔交易：算成功', async () => {
  const { store, chain, op, done } = setup({ latest: 1n });
  try {
    chain.sendImpl = (raw) => { chain.mine(hashOf(raw)); return { known: true, reason: 'nonceUsed' }; };
    const hash = await op().send(upload(0), { kind: 'upload' });
    assert.equal(hash, hashOf(chain.sent[0]));
    const rec = store.get(BSC.chainId, C);
    assert.equal(rec.pending, null);
    assert.equal(rec.lastNonce, 1n);
  } finally { done(); }
});

test('sendRaw 返回 nonceUsed、但 nonce 被别的交易用掉：清除 pending 并报状态异常', async () => {
  const { store, chain, op, done } = setup({ latest: 1n });
  try {
    chain.sendImpl = () => { chain.latest = chain.pending = 2n; return { known: true, reason: 'nonceUsed' }; };
    await assert.rejects(op().send(upload(0), { kind: 'upload' }), /临时钱包的交易状态异常，请重新检查/);
    const rec = store.get(BSC.chainId, C);
    assert.equal(rec.pending, null);
    assert.equal(rec.lastNonce, 1n);
  } finally { done(); }
});

test('sendRaw 返回 pending（已在交易池）：算广播成功', async () => {
  const { store, chain, op, done } = setup();
  try {
    chain.sendImpl = () => ({ known: true, reason: 'pending' });
    const hash = await op().send(upload(0), { kind: 'upload' });
    assert.equal(hash, hashOf(chain.sent[0]));
    assert.equal(store.get(BSC.chainId, C).pending.hash, hash);
  } finally { done(); }
});

test('节点返回的哈希和签出来的不一致：pending 保留并报错', async () => {
  const { store, chain, op, done } = setup();
  try {
    chain.sendImpl = () => '0x' + '99'.repeat(32);
    await assert.rejects(op().send(upload(0), { kind: 'upload' }), /节点返回的交易哈希不一致/);
    assert.equal(store.get(BSC.chainId, C).pending.hash, hashOf(chain.sent[0]));
  } finally { done(); }
});

test('节点返回大写哈希也算一致', async () => {
  const { chain, op, done } = setup();
  try {
    chain.sendImpl = (raw) => '0x' + hashOf(raw).slice(2).toUpperCase();
    assert.equal(await op().send(upload(0), { kind: 'upload' }), hashOf(chain.sent[0]));
  } finally { done(); }
});

test('回执 status 0 正常返回，nonce 照样记为已用', async () => {
  const { store, chain, op, done } = setup({ latest: 4n });
  try {
    const o = op();
    const hash = await o.send(upload(0), { kind: 'upload' });
    chain.mine(hash, 0);
    const r = await o.settle();
    assert.equal(r.status, 0);
    assert.equal(r.hash, hash);
    assert.equal(store.get(BSC.chainId, C).pending, null);
    assert.equal(store.get(BSC.chainId, C).lastNonce, 4n);
  } finally { done(); }
});

test('settle 超时：pending 保留，每轮重发同一笔，重发出错不中止', async () => {
  const { store, chain, clock, op, done } = setup();
  try {
    const o = op();
    const hash = await o.send(upload(0), { kind: 'upload' });
    let n = 0;
    chain.sendImpl = () => {
      n++;
      if (n % 3 === 1) throw new Error('网络断了');
      return n % 3 === 2 ? { known: true, reason: 'pending' } : { known: true, reason: 'nonceUsed' };
    };
    await assert.rejects(o.settle({ timeoutMs: 10000, pollMs: 3000 }), /交易还没确认，可以稍后继续/);
    assert.equal(store.get(BSC.chainId, C).pending.hash, hash);
    assert.ok(clock.sleeps >= 3);
    assert.ok(n >= 3);
    assert.ok(chain.sent.every((raw) => raw === chain.sent[0]));
    // timeoutMs 0：只查一次，不等
    const before = clock.sleeps;
    await assert.rejects(o.settle({ timeoutMs: 0 }), /交易还没确认/);
    assert.equal(clock.sleeps, before);
  } finally { done(); }
});

test('settle 时发现 nonce 被别的交易用掉：清除 pending 并报状态异常', async () => {
  const { store, chain, op, done } = setup({ latest: 2n });
  try {
    const o = op();
    await o.send(upload(0), { kind: 'upload' });
    chain.latest = chain.pending = 3n;
    await assert.rejects(o.settle(), /临时钱包的交易状态异常/);
    assert.equal(store.get(BSC.chainId, C).pending, null);
    assert.equal(store.get(BSC.chainId, C).lastNonce, 2n);
  } finally { done(); }
});

test('签名期间修改传进来的 tx 不影响签出来的交易', async () => {
  const { chain, op, done } = setup();
  try {
    const tx = upload(0);
    const data = tx.data;
    // 读 nonce 时（复制之后、签名之前）改掉原对象
    chain.onNonce = () => { tx.data = upload(1).data; tx.to = OWNER; tx.gas = 1n; };
    await op().send(tx, { kind: 'upload' });
    const d = decodeRaw(chain.sent[0]);
    assert.equal(d.data, data);
    assert.equal(d.to, BSC.registry);
    assert.equal(d.gas, 5000000n);
  } finally { done(); }
});

test('没有临时钱包或持有人不一致时 createOperator 抛出', () => {
  const { store, chain, done } = setup();
  try {
    const mk = (o) => () => createOperator({ store, chain, net: BSC, container: C, owner: OWNER, ...o });
    assert.doesNotThrow(mk({ owner: OWNER.toUpperCase().replace('0X', '0x') }));
    assert.throws(mk({ owner: '0x' + '22'.repeat(20) }), /持有人/);
    assert.throws(mk({ container: '0x' + '33'.repeat(20) }), /临时钱包不存在/);
  } finally { done(); }
});

test('同时两次 send：只签一笔、只广播一次，另一次报正在处理', async () => {
  const { store, chain, op, done } = setup({ latest: 3n });
  try {
    const o = op();
    const results = await Promise.allSettled([
      o.send(upload(0), { kind: 'upload', path: 'a.js', index: 0 }),
      o.send(upload(1), { kind: 'upload', path: 'a.js', index: 1 }),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.match(results[1].reason.message, /临时钱包正在处理另一笔交易/);
    assert.equal(chain.sent.length, 1);
    assert.equal(store.get(BSC.chainId, C).pending.hash, results[0].value);
    // send 进行中时 settle 也被拒；send 结束后可以 settle
    const p = o.send(upload(0), { kind: 'upload' });
    await assert.rejects(o.settle(), /临时钱包正在处理另一笔交易/);
    await assert.rejects(p, /还有一笔交易在等确认/);
    chain.mine(results[0].value);
    assert.equal((await o.settle()).hash, results[0].value);
  } finally { done(); }
});

test('同时两次 settle：第二次报正在处理', async () => {
  const { chain, op, done } = setup();
  try {
    const o = op();
    const hash = await o.send(upload(0), { kind: 'upload' });
    chain.mine(hash);
    const [a, b] = await Promise.allSettled([o.settle(), o.settle()]);
    assert.equal(a.value.hash, hash);
    assert.match(b.reason.message, /临时钱包正在处理另一笔交易/);
  } finally { done(); }
});

test('回执节点落后：第一次查不到回执、nonce 已前进，复查查到后正常确认', async () => {
  const { store, chain, clock, op, done } = setup({ latest: 2n });
  try {
    const o = op();
    const hash = await o.send(upload(0), { kind: 'upload' });
    chain.mine(hash);
    const real = chain.receipts.get(hash);
    chain.receiptImpl = (h, n) => (n === 1 ? null : real);
    const before = clock.sleeps;
    const r = await o.settle({ timeoutMs: 0 });
    assert.equal(r.hash, hash);
    assert.equal(r.status, 1);
    assert.equal(chain.receiptCalls, 2);
    // timeoutMs 0 也多等一轮再复查
    assert.equal(clock.sleeps, before + 1);
    const rec = store.get(BSC.chainId, C);
    assert.equal(rec.pending, null);
    assert.equal(rec.lastNonce, 2n);
  } finally { done(); }
});

test('nonceUsed 时回执节点落后：复查查到就是这笔，send 算成功', async () => {
  const { store, chain, op, done } = setup({ latest: 1n });
  try {
    let real;
    chain.sendImpl = (raw) => { chain.mine(hashOf(raw)); real = chain.receipts.get(hashOf(raw)); return { known: true, reason: 'nonceUsed' }; };
    chain.receiptImpl = (h, n) => (n === 1 ? null : real);
    const hash = await op().send(upload(0), { kind: 'upload' });
    assert.equal(hash, hashOf(chain.sent[0]));
    assert.equal(store.get(BSC.chainId, C).pending, null);
    assert.equal(store.get(BSC.chainId, C).lastNonce, 1n);
  } finally { done(); }
});

test('setLastNonce 之后、clearPending 之前崩溃：重新 settle 幂等确认', async () => {
  const { store, chain, op, done } = setup({ latest: 6n });
  try {
    const hash = await op().send(upload(0), { kind: 'upload' });
    chain.mine(hash);
    // 模拟崩溃：只做了第一步
    store.setLastNonce(BSC.chainId, C, 6n);
    assert.ok(store.get(BSC.chainId, C).pending);
    const r = await op().settle();
    assert.equal(r.hash, hash);
    const rec = store.get(BSC.chainId, C);
    assert.equal(rec.pending, null);
    assert.equal(rec.lastNonce, 6n);
  } finally { done(); }
});

test('store 拒绝旧 nonce 时 operator 不广播', async () => {
  const { store, chain, op, done } = setup({ latest: 5n });
  try {
    const o = op();
    store.setLastNonce(BSC.chainId, C, 5n);
    // operator 读到的 lastNonce 一律藏掉，绕过它自己的检查；store.setPending 仍按盘上的 5 拒绝
    const realGet = store.get;
    store.get = (...a) => { const r = realGet(...a); return r && { ...r, lastNonce: null }; };
    await assert.rejects(o.send(upload(0), { kind: 'upload' }), /nonce 不比已确认的大/);
    assert.equal(chain.sent.length, 0);
    assert.equal(realGet(BSC.chainId, C).pending, null);
  } finally { done(); }
});
