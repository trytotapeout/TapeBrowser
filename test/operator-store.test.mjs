import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperatorStore } from '../src/main/operator-store.js';
import { addressOf } from '../src/main/eth-tx.js';
import { bytesToHex } from '../src/main/abi.js';

const CHAIN = 56;
const C = '0x' + 'Ab'.repeat(20);
const OWNER = '0x' + '11'.repeat(20);
const OTHER = '0x' + '22'.repeat(20);

// 假加密：反转后加前缀，能还原但文件里看不到明文
const encrypt = (s) => Buffer.from('enc:' + [...s].reverse().join(''), 'utf8');
const decrypt = (buf) => {
  const s = Buffer.from(buf).toString('utf8');
  if (!s.startsWith('enc:')) throw new Error('bad ciphertext SECRET-DETAIL');
  return [...s.slice(4)].reverse().join('');
};

function setup(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opstore-'));
  const make = (o = {}) => createOperatorStore({ dir, encrypt, decrypt, now: () => 1234, ...opts, ...o });
  return { dir, store: make(), make, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 目录里所有文件拼起来的内容 */
const allFiles = (dir) => readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

test('新建临时钱包，再次 create 返回同一个地址', () => {
  const { dir, store, done } = setup();
  try {
    const a = store.create({ chainId: CHAIN, container: C, owner: OWNER });
    assert.match(a.address, /^0x[0-9a-f]{40}$/);
    assert.equal(a.container, C.toLowerCase());
    assert.equal(a.chainId, CHAIN);
    assert.equal(a.owner, OWNER);
    assert.equal(a.pending, null);
    assert.equal(a.lastNonce, null);
    assert.equal(a.createdAt, 1234);
    assert.equal('key' in a, false);
    assert.deepEqual(readdirSync(dir), [`${CHAIN}-${C.toLowerCase()}.json`]);
    const b = store.create({ chainId: CHAIN, container: C.toLowerCase(), owner: OWNER.toUpperCase().replace('0X', '0x') });
    assert.equal(b.address, a.address);
    assert.deepEqual(store.get(CHAIN, C), a);
  } finally { done(); }
});

test('换个持有人会抛出', () => {
  const { dir, store, done } = setup();
  try {
    const a = store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const hex = bytesToHex(store.keyOf(CHAIN, C)).slice(2);
    let err;
    try { store.create({ chainId: CHAIN, container: C, owner: OTHER }); } catch (e) { err = e; }
    assert.ok(err instanceof Error);
    assert.equal(err.message, '这个容器已有另一个持有人的临时钱包，请先把它的余额退回原持有人');
    assert.equal(err.code, 'OPERATOR_OWNER_MISMATCH');
    assert.equal(err.old.address, a.address);
    assert.equal(err.old.owner, OWNER);
    assert.equal('key' in err.old, false);
    const dump = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    assert.equal(dump(err).includes(hex), false);
    assert.equal(dump(err.old).includes(hex), false);
    const stored = JSON.parse(readFileSync(join(dir, `${CHAIN}-${C.toLowerCase()}.json`), 'utf8')).key;
    assert.equal(dump(err).includes(stored), false);
    assert.equal(dump(err.old).includes(stored), false);
  } finally { done(); }
});

test('文件里找不到明文私钥；keyOf 能解出私钥且地址一致', () => {
  const { dir, store, done } = setup();
  try {
    const a = store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const sk = store.keyOf(CHAIN, C);
    assert.ok(sk instanceof Uint8Array);
    assert.equal(sk.length, 32);
    assert.equal(addressOf(sk), a.address);
    const hex = bytesToHex(sk).slice(2);
    const text = allFiles(dir);
    assert.equal(text.toLowerCase().includes(hex), false);
    assert.equal(JSON.stringify(store.get(CHAIN, C)).includes(hex), false);
    assert.equal(JSON.stringify(store.list()).includes(hex), false);
  } finally { done(); }
});

test('解密失败或文件被篡改时抛出固定的提示，不带底层错误', () => {
  const { dir, store, make, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const MSG = '临时钱包无法解密（系统钥匙串可能已重置）';
    const broken = make({ decrypt: () => { throw new Error('SECRET-DETAIL'); } });
    assert.throws(() => broken.keyOf(CHAIN, C), (e) => e.message === MSG);
    // 改掉记录里的地址：解出的私钥和地址对不上
    const file = join(dir, `${CHAIN}-${C.toLowerCase()}.json`);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    rec.address = OTHER;
    writeFileSync(file, JSON.stringify(rec));
    assert.throws(() => store.keyOf(CHAIN, C), (e) => e.message === MSG);
    // 解出来不是 32 字节私钥
    rec.key = encrypt('hello').toString('base64');
    writeFileSync(file, JSON.stringify(rec));
    assert.throws(() => store.keyOf(CHAIN, C), (e) => e.message === MSG);
  } finally { done(); }
});

test('encrypt 抛错时原样抛出，不写盘', () => {
  const err = new Error('钥匙串不可用');
  const { dir, store, done } = setup({ encrypt: () => { throw err; } });
  try {
    assert.throws(() => store.create({ chainId: CHAIN, container: C, owner: OWNER }), (e) => e === err);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(store.get(CHAIN, C), null);
  } finally { done(); }
});

test('pending 写入后重建 store 还能读到；clearPending 清掉', () => {
  const { store, make, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const p = { raw: '0xf86b', hash: '0x' + 'cd'.repeat(32), kind: 'upload', path: 'index.html', index: 2, nonce: 7n };
    store.setPending(CHAIN, C, p);
    const r = make().get(CHAIN, C);
    assert.deepEqual(r.pending, p);
    store.clearPending(CHAIN, C);
    store.setPending(CHAIN, C, { raw: '0x01', hash: '0x02', kind: 'refund', nonce: 8 });
    assert.deepEqual(make().get(CHAIN, C).pending, { raw: '0x01', hash: '0x02', kind: 'refund', nonce: 8n });
    store.clearPending(CHAIN, C);
    assert.equal(make().get(CHAIN, C).pending, null);
    assert.throws(() => store.setPending(CHAIN, C, { ...p, kind: 'other' }));
    assert.throws(() => store.setPending(CHAIN, C, { ...p, nonce: -1 }));
  } finally { done(); }
});

test('lastNonce 只能往大改，并且写盘', () => {
  const { dir, store, make, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    store.setLastNonce(CHAIN, C, 5n);
    assert.equal(make().get(CHAIN, C).lastNonce, 5n);
    store.setLastNonce(CHAIN, C, 3);
    assert.equal(store.get(CHAIN, C).lastNonce, 5n);
    store.setLastNonce(CHAIN, C, 5);
    assert.equal(store.get(CHAIN, C).lastNonce, 5n);
    store.setLastNonce(CHAIN, C, 6);
    assert.equal(make().get(CHAIN, C).lastNonce, 6n);
    const rec = JSON.parse(readFileSync(join(dir, `${CHAIN}-${C.toLowerCase()}.json`), 'utf8'));
    assert.equal(rec.lastNonce, '6');
    assert.throws(() => store.setLastNonce(CHAIN, C, -1));
    assert.throws(() => store.setLastNonce(CHAIN, C, 1.5));
  } finally { done(); }
});

test('没有记录时修改类方法抛出', () => {
  const { store, done } = setup();
  try {
    assert.throws(() => store.setLastNonce(CHAIN, C, 1));
    assert.throws(() => store.setPending(CHAIN, C, { raw: '0x', hash: '0x', kind: 'upload', nonce: 0 }));
    assert.throws(() => store.keyOf(CHAIN, C));
  } finally { done(); }
});

test('remove 之后 get 返回 null', () => {
  const { dir, store, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    store.remove(CHAIN, C);
    assert.equal(store.get(CHAIN, C), null);
    assert.deepEqual(readdirSync(dir), []);
    store.remove(CHAIN, C); // 不存在时不抛
  } finally { done(); }
});

test('list 列出全部记录并跳过坏文件', () => {
  const { dir, store, done } = setup();
  try {
    const a = store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const b = store.create({ chainId: 196, container: C, owner: OTHER });
    writeFileSync(join(dir, `1-0x${'33'.repeat(20)}.json`), '{not json');
    writeFileSync(join(dir, `10-0x${'44'.repeat(20)}.json`), '"just a string"');
    writeFileSync(join(dir, 'readme.txt'), 'hi');
    const list = store.list().sort((x, y) => x.chainId - y.chainId);
    assert.deepEqual(list, [a, b]);
    assert.ok(list.every((r) => !('key' in r)));
  } finally { done(); }
});

test('list 在目录不存在时返回空数组', () => {
  const { dir, make, done } = setup();
  try {
    const s = make({ dir: join(dir, 'missing') });
    assert.deepEqual(s.list(), []);
  } finally { done(); }
});

test('chainId 和 container 不合法时抛出，不会写到目录外面', () => {
  const { dir, store, done } = setup();
  try {
    for (const chainId of [0, -1, 1.5, '56', NaN, 2 ** 60]) {
      assert.throws(() => store.create({ chainId, container: C, owner: OWNER }));
      assert.throws(() => store.get(chainId, C));
    }
    for (const container of ['../x', C + '/..', '0x1234', C.slice(0, -1) + 'g', null]) {
      assert.throws(() => store.create({ chainId: CHAIN, container, owner: OWNER }));
      assert.throws(() => store.get(CHAIN, container));
      assert.throws(() => store.remove(CHAIN, container));
    }
    assert.throws(() => store.create({ chainId: CHAIN, container: C, owner: 'bob' }));
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(existsSync(join(dir, '..', 'x')), false);
  } finally { done(); }
});

test('文件权限是 0600，写完不留 .tmp', { skip: process.platform === 'win32' }, () => {
  const { dir, store, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    store.setLastNonce(CHAIN, C, 1);
    const file = join(dir, `${CHAIN}-${C.toLowerCase()}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), [`${CHAIN}-${C.toLowerCase()}.json`]);
  } finally { done(); }
});

test('坏文件出现在 broken() 里，list 跳过，get 抛出固定提示', () => {
  const { dir, store, done } = setup();
  try {
    const a = store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const bad1 = `1-0x${'33'.repeat(20)}.json`;
    const bad2 = `10-0x${'44'.repeat(20)}.json`;
    writeFileSync(join(dir, bad1), '{not json');
    writeFileSync(join(dir, bad2), JSON.stringify({ v: 1, chainId: 10 }));
    writeFileSync(join(dir, 'readme.txt'), 'hi');
    assert.deepEqual(store.broken().sort(), [bad1, bad2].sort());
    assert.deepEqual(store.list(), [a]);
    for (const [chainId, c] of [[1, '0x' + '33'.repeat(20)], [10, '0x' + '44'.repeat(20)]]) {
      assert.throws(() => store.get(chainId, c), (e) => e.message === '临时钱包：记录文件已损坏');
    }
  } finally { done(); }
});

test('broken 在目录不存在时返回空数组', () => {
  const { dir, make, done } = setup();
  try {
    assert.deepEqual(make({ dir: join(dir, 'missing') }).broken(), []);
  } finally { done(); }
});

test('setPending 拒绝不比 lastNonce 大的 nonce', () => {
  const { store, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const p = { raw: '0x01', hash: '0x02', kind: 'upload', nonce: 5n };
    store.setPending(CHAIN, C, p); // 还没有 lastNonce，可以
    store.setLastNonce(CHAIN, C, 5n);
    store.clearPending(CHAIN, C);
    const MSG = '交易的 nonce 不比已确认的大，节点可能落后';
    assert.throws(() => store.setPending(CHAIN, C, p), (e) => e.message === MSG);
    assert.throws(() => store.setPending(CHAIN, C, { ...p, nonce: 4 }), (e) => e.message === MSG);
    assert.equal(store.get(CHAIN, C).pending, null);
    store.setPending(CHAIN, C, { ...p, nonce: 6n });
    assert.equal(store.get(CHAIN, C).pending.nonce, 6n);
  } finally { done(); }
});

test('已有 pending 时 setPending 拒绝，必须先 clearPending', () => {
  const { store, make, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const p = { raw: '0x01', hash: '0x02', kind: 'upload', nonce: 3n };
    store.setPending(CHAIN, C, p);
    assert.throws(() => store.setPending(CHAIN, C, { ...p, raw: '0x03', hash: '0x04', nonce: 4n }),
      (e) => e.message === '临时钱包还有一笔交易在等确认');
    // 同一笔也不行，原来的 pending 不变
    assert.throws(() => store.setPending(CHAIN, C, p), /还有一笔交易在等确认/);
    assert.deepEqual(make().get(CHAIN, C).pending, p);
    store.clearPending(CHAIN, C);
    store.setPending(CHAIN, C, { ...p, nonce: 4n });
    assert.equal(store.get(CHAIN, C).pending.nonce, 4n);
  } finally { done(); }
});

test('setPending / setLastNonce 拒绝不合法的参数', () => {
  const { store, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const p = { raw: '0x01', hash: '0x02', kind: 'upload', nonce: 1n };
    for (const bad of [{ kind: 'mint' }, { kind: undefined }, { index: -1 }, { index: 1.5 }, { nonce: 1.5 }, { nonce: -1 }, { nonce: '1' }, { raw: 1 }]) {
      assert.throws(() => store.setPending(CHAIN, C, { ...p, ...bad }));
    }
    assert.throws(() => store.setPending(CHAIN, C, null));
    for (const bad of [-1, -1n, 1.5, '3', NaN, null]) {
      assert.throws(() => store.setLastNonce(CHAIN, C, bad));
    }
    const r = store.get(CHAIN, C);
    assert.equal(r.pending, null);
    assert.equal(r.lastNonce, null);
  } finally { done(); }
});

test('写盘前删掉残留的 .tmp，新文件仍是 0600', { skip: process.platform === 'win32' }, () => {
  const { dir, store, done } = setup();
  try {
    const file = join(dir, `${CHAIN}-${C.toLowerCase()}.json`);
    writeFileSync(file + '.tmp', 'stale', { mode: 0o644 });
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), [`${CHAIN}-${C.toLowerCase()}.json`]);
  } finally { done(); }
});

test('pending 可以带 gasPrice（十进制落盘，读出 bigint）；不合法的 gasPrice 拒绝', () => {
  const { dir, store, make, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const p = { raw: '0x01', hash: '0x' + 'cd'.repeat(32), kind: 'upload', path: 'a', index: 0, nonce: 1n, gasPrice: 50000000n };
    store.setPending(CHAIN, C, p);
    assert.deepEqual(make().get(CHAIN, C).pending, p);
    assert.match(allFiles(dir), /"gasPrice": "50000000"/);
    store.clearPending(CHAIN, C);
    assert.throws(() => store.setPending(CHAIN, C, { ...p, gasPrice: -1n }));
    assert.throws(() => store.setPending(CHAIN, C, { ...p, gasPrice: '5' }));
    assert.equal(store.get(CHAIN, C).pending, null);
  } finally { done(); }
});

test('ownerPending：新建为 null；写入后重建还能读到；已有时拒绝；clearOwnerPending 清掉', () => {
  const { store, make, done } = setup();
  try {
    assert.equal(store.create({ chainId: CHAIN, container: C, owner: OWNER }).ownerPending, null);
    const hash = '0x' + 'AB'.repeat(32);
    store.setOwnerPending(CHAIN, C, { kind: 'open', hash, at: 99, nonce: 4n });
    assert.deepEqual(make().get(CHAIN, C).ownerPending, { kind: 'open', hash: hash.toLowerCase(), at: 99, nonce: 4n });
    // 一次只能有一笔：覆盖会丢掉还没确认的交易
    assert.throws(() => store.setOwnerPending(CHAIN, C, { kind: 'fund', hash: '0x' + 'cd'.repeat(32), at: 1, nonce: 5n }), /持有人还有一笔交易在等确认/);
    assert.equal(make().get(CHAIN, C).ownerPending.kind, 'open');
    store.clearOwnerPending(CHAIN, C);
    assert.equal(make().get(CHAIN, C).ownerPending, null);
    // 和临时钱包的 pending 互不影响
    assert.equal(make().get(CHAIN, C).pending, null);
  } finally { done(); }
});

test('setOwnerPending 校验 kind、hash 和 at', () => {
  const { store, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const ok = { kind: 'grant', hash: '0x' + 'cd'.repeat(32), at: 1, nonce: 0n };
    const { nonce: _n, ...noNonce } = ok;
    for (const bad of [{ ...ok, kind: 'upload' }, { ...ok, hash: '0x12' }, { ...ok, hash: 'cd'.repeat(33) }, { ...ok, at: -1 }, { ...ok, at: 1.5 },
      { ...ok, nonce: -1n }, { ...ok, nonce: '3' }, noNonce, null]) {
      assert.throws(() => store.setOwnerPending(CHAIN, C, bad));
    }
    assert.equal(store.get(CHAIN, C).ownerPending, null);
    assert.throws(() => store.setOwnerPending(CHAIN, '0x' + '99'.repeat(20), ok), /临时钱包不存在/);
  } finally { done(); }
});

test('旧格式的记录（没有 ownerPending 字段）照常读，ownerPending 为 null', () => {
  const { dir, store, make, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const file = join(dir, readdirSync(dir)[0]);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    delete rec.ownerPending;
    writeFileSync(file, JSON.stringify(rec));
    assert.equal(make().get(CHAIN, C).ownerPending, null);
  } finally { done(); }
});

test('ownerPending 结构不对的文件算损坏', () => {
  const { dir, store, make, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const file = join(dir, readdirSync(dir)[0]);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    rec.ownerPending = { kind: 'open', hash: 'nope', at: 1 };
    writeFileSync(file, JSON.stringify(rec));
    assert.throws(() => make().get(CHAIN, C), /记录文件已损坏/);
  } finally { done(); }
});

test('minBlock：新建为 null；setMinBlock 只能往大改，重建后还在', () => {
  const { store, make, done } = setup();
  try {
    assert.equal(store.create({ chainId: CHAIN, container: C, owner: OWNER }).minBlock, null);
    store.setMinBlock(CHAIN, C, 120n);
    store.setMinBlock(CHAIN, C, 100n);
    assert.equal(make().get(CHAIN, C).minBlock, 120n);
    store.setMinBlock(CHAIN, C, 130n);
    assert.equal(make().get(CHAIN, C).minBlock, 130n);
    assert.throws(() => store.setMinBlock(CHAIN, C, -1n));
  } finally { done(); }
});

test('ownerPending.nonce 落盘为十进制字符串；旧记录没有 nonce 照常读，nonce 为 null', () => {
  const { dir, store, make, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    store.setOwnerPending(CHAIN, C, { kind: 'fund', hash: '0x' + 'cd'.repeat(32), at: 1, nonce: 12n });
    assert.match(allFiles(dir), /"nonce": "12"/);
    const file = join(dir, readdirSync(dir)[0]);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    delete rec.ownerPending.nonce;
    writeFileSync(file, JSON.stringify(rec));
    assert.deepEqual(make().get(CHAIN, C).ownerPending, { kind: 'fund', hash: '0x' + 'cd'.repeat(32), at: 1, nonce: null });
    rec.ownerPending.nonce = 'x1';
    writeFileSync(file, JSON.stringify(rec));
    assert.throws(() => make().get(CHAIN, C), /记录文件已损坏/);
  } finally { done(); }
});

test('退款 pending 可以带 value（十进制落盘，读出 bigint）', () => {
  const { dir, store, make, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const p = { raw: '0x01', hash: '0x' + 'cd'.repeat(32), kind: 'refund', nonce: 3n, gasPrice: 5n, value: 1000n };
    store.setPending(CHAIN, C, p);
    assert.deepEqual(make().get(CHAIN, C).pending, p);
    assert.match(allFiles(dir), /"value": "1000"/);
    store.clearPending(CHAIN, C);
    assert.throws(() => store.setPending(CHAIN, C, { ...p, value: -1n }));
  } finally { done(); }
});

test('replacePending：只能用同一个 nonce 的退款替换退款', () => {
  const { store, done } = setup();
  try {
    store.create({ chainId: CHAIN, container: C, owner: OWNER });
    const refund = { raw: '0x01', hash: '0x' + 'cd'.repeat(32), kind: 'refund', nonce: 3n, gasPrice: 5n, value: 1000n };
    const next = { ...refund, raw: '0x02', hash: '0x' + 'ef'.repeat(32), value: 900n };
    // 没有 pending
    assert.throws(() => store.replacePending(CHAIN, C, next), /只能用同一个 nonce 的退款替换退款/);
    store.setPending(CHAIN, C, { raw: '0x03', hash: '0x' + 'aa'.repeat(32), kind: 'upload', path: 'a', index: 0, nonce: 3n });
    assert.throws(() => store.replacePending(CHAIN, C, next), /只能用同一个 nonce 的退款替换退款/);
    store.clearPending(CHAIN, C);
    store.setPending(CHAIN, C, refund);
    assert.throws(() => store.replacePending(CHAIN, C, { ...next, nonce: 4n }), /只能用同一个 nonce 的退款替换退款/);
    assert.throws(() => store.replacePending(CHAIN, C, { ...next, kind: 'upload' }), /只能用同一个 nonce 的退款替换退款/);
    assert.equal(store.get(CHAIN, C).pending.hash, refund.hash);
    store.replacePending(CHAIN, C, next);
    assert.deepEqual(store.get(CHAIN, C).pending, next);
  } finally { done(); }
});
