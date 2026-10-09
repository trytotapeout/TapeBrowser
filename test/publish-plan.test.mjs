import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planPublish, chunkOf, stepsOf, CHUNK_BYTES } from '../src/main/publish-plan.js';

const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
const file = (path, size, fill = 1) => { const bytes = new Uint8Array(size).fill(fill); return { path, bytes, sha256: sha(bytes) }; };
// 链上已经传了 count 块的同一个文件
const onChain = (f, count, contentType) => ({
  size: Math.min(count * CHUNK_BYTES, f.bytes.length), contentType, sha256: f.sha256, updatedAt: 1, chunkCount: count,
});
const row = (p, path) => p.rows.find((r) => r.path === path);

test('新文件全部 create，index.html 排最后，交易数按 24000 字节一块', () => {
  const files = [file('index.html', 100), file('b.js', 50000), file('a.css', 10)];
  const p = planPublish(files, [null, null, null]);
  assert.deepEqual(p.rows.map((r) => r.path), ['a.css', 'b.js', 'index.html']);
  assert.deepEqual(p.rows.map((r) => r.action), ['create', 'create', 'create']);
  assert.equal(row(p, 'b.js').remaining, 3);
  assert.equal(p.transactions, 5);
  assert.equal(row(p, 'a.css').contentType, 'text/css; charset=utf-8');
  assert.deepEqual(p.conflicts, []);
});

test('内容相同的复用，传了一半的接着传', () => {
  const big = file('big.png', 60000);
  const same = file('a.js', 10);
  const p = planPublish([big, same], [onChain(big, 1, 'image/png'), onChain(same, 1, 'text/javascript; charset=utf-8')]);
  assert.equal(row(p, 'a.js').action, 'reuse');
  assert.equal(row(p, 'big.png').action, 'append');
  assert.equal(row(p, 'big.png').from, 1);
  assert.equal(row(p, 'big.png').remaining, 2);
  assert.equal(p.transactions, 2);
  assert.equal(p.reused, 1);
  assert.equal(p.uploadBytes, 60000 - CHUNK_BYTES);
});

test('首页内容变了：不管多大都在最后整个替换，超过一块就分几笔', () => {
  const oldIndex = file('index.html', 100, 1);
  const small = file('index.html', 100, 2);
  const p = planPublish([small], [onChain(oldIndex, 1, 'text/html; charset=utf-8')]);
  assert.equal(row(p, 'index.html').action, 'replace');
  assert.equal(row(p, 'index.html').remaining, 1);
  for (const [size, n] of [[CHUNK_BYTES + 1, 2], [60000, 3]]) {
    const big = file('index.html', size, 2);
    const q = planPublish([big], [onChain(oldIndex, 1, 'text/html; charset=utf-8')]);
    assert.deepEqual(q.conflicts, [], String(size));
    const r = row(q, 'index.html');
    assert.equal(r.action, 'replace');
    assert.equal(r.from, 0);
    assert.equal(r.remaining, n);
    assert.equal(r.uploadBytes, size);
    assert.equal(q.transactions, n);
    // 第 0 块用 putFile 整个替换，后面的用 appendChunk
    assert.deepEqual(stepsOf(q).map((s) => s.index), [...Array(n).keys()]);
  }
});

test('多块首页替换到一半中断：putFile 已经换上新 sha，接着从第 1 块传', () => {
  const f = file('index.html', 60000, 2);
  const p = planPublish([f], [{ size: CHUNK_BYTES, contentType: 'text/html; charset=utf-8', sha256: f.sha256, updatedAt: 1, chunkCount: 1 }]);
  const r = row(p, 'index.html');
  assert.equal(r.action, 'append');
  assert.equal(r.from, 1);
  assert.equal(r.remaining, 2);
  assert.deepEqual(stepsOf(p).map((s) => s.index), [1, 2]);
});

test('其他文件内容变了是冲突，contentType 不同也算变了，链上分块异常也是冲突', () => {
  const a = file('a.js', 10, 1);
  const changed = file('a.js', 10, 2);
  const b = file('b.css', 10);
  const c = file('c.png', 30000);
  const bad = { ...onChain(c, 1, 'image/png'), size: 5 };
  const p = planPublish([changed, b, c], [onChain(a, 1, 'text/javascript; charset=utf-8'), onChain(b, 1, 'text/plain'), bad]);
  assert.deepEqual(p.conflicts.map((x) => [x.path, x.reason]), [['a.js', 'changed'], ['b.css', 'changed'], ['c.png', 'corrupt']]);
});

test('stepsOf：按顺序列出每一笔交易，第 0 块用 putFile', () => {
  const big = file('big.png', 60000);
  const p = planPublish([big, file('index.html', 10)], [onChain(big, 1, 'image/png'), null]);
  assert.deepEqual(stepsOf(p).map((s) => [s.path, s.index]), [['big.png', 1], ['big.png', 2], ['index.html', 0]]);
  assert.equal(chunkOf(big.bytes, 2).length, 60000 - 2 * CHUNK_BYTES);
});

test('空文件也要一笔 putFile', () => {
  const p = planPublish([file('empty.txt', 0)], [null]);
  assert.equal(row(p, 'empty.txt').remaining, 1);
});

test('链上 contentType 为空或只是大小写/参数不同，都算一致', () => {
  const f = file('index.html', 10);
  for (const t of ['', 'TEXT/HTML', ' text/html ; charset=UTF-8']) {
    const p = planPublish([f], [onChain(f, 1, t)]);
    assert.equal(row(p, 'index.html').action, 'reuse', t);
  }
  const g = file('a.js', 10);
  assert.equal(planPublish([g], [onChain(g, 1, 'text/css')]).conflicts[0].reason, 'changed');
});

test('sha256 大小写不同也算一致', () => {
  const f = file('a.js', 10);
  const p = planPublish([f], [{ ...onChain(f, 1, 'text/javascript'), sha256: f.sha256.toUpperCase().replace('0X', '0x') }]);
  assert.equal(row(p, 'a.js').action, 'reuse');
});

test('别的工具传的完整文件，块数不是按 24000 分也复用', () => {
  const f = file('big.png', 60000);
  const p = planPublish([f], [{ size: 60000, contentType: 'image/png', sha256: f.sha256, updatedAt: 1, chunkCount: 5 }]);
  assert.equal(row(p, 'big.png').action, 'reuse');
  assert.deepEqual(p.conflicts, []);
});

test('新文件 putFile 已上链（1 块 24000 字节），从第 1 块接着传', () => {
  const f = file('big.png', 60000);
  const p = planPublish([f], [{ size: CHUNK_BYTES, contentType: 'image/png', sha256: f.sha256, updatedAt: 1, chunkCount: 1 }]);
  assert.equal(row(p, 'big.png').action, 'append');
  assert.equal(row(p, 'big.png').from, 1);
  assert.equal(row(p, 'big.png').remaining, 2);
  assert.equal(p.uploadBytes, 60000 - CHUNK_BYTES);
});

test('上次的 replace 已上链，这次首页复用', () => {
  const f = file('index.html', 100, 2);
  const p = planPublish([f], [onChain(f, 1, 'text/html; charset=utf-8')]);
  assert.equal(row(p, 'index.html').action, 'reuse');
  assert.equal(p.transactions, 0);
});

test('没传完但块数比本地还多，算分块异常', () => {
  const f = file('big.png', 60000);
  const p = planPublish([f], [{ size: 2 * CHUNK_BYTES, contentType: 'image/png', sha256: f.sha256, updatedAt: 1, chunkCount: 4 }]);
  assert.deepEqual(p.conflicts, [{ path: 'big.png', reason: 'corrupt' }]);
});

test('冲突按路径排序，根目录首页不会成为冲突；子目录的 index.html 是普通文件', () => {
  const big = file('index.html', CHUNK_BYTES + 1, 2);
  const sub = file('sub/index.html', CHUNK_BYTES + 1, 2);
  const z = file('z.js', 10, 2);
  const c = file('c.png', 30000);
  const old = (path) => ({ size: 10, contentType: '', sha256: sha(new Uint8Array(10).fill(9)), updatedAt: 1, chunkCount: 1, path });
  const p = planPublish([z, big, sub, c], [old(), old(), old(), { ...onChain(c, 1, ''), size: 5 }]);
  assert.deepEqual(p.conflicts.map((x) => [x.path, x.reason]), [['c.png', 'corrupt'], ['sub/index.html', 'changed'], ['z.js', 'changed']]);
  assert.equal(row(p, 'index.html').action, 'replace');
});

test('首页内容相同但链上分块异常：整个重传；其他文件同样情况还是 corrupt', () => {
  const idx = file('index.html', 30000);
  const bad = (f) => ({ size: 5, contentType: '', sha256: f.sha256, updatedAt: 1, chunkCount: 1 });
  const p = planPublish([idx], [bad(idx)]);
  assert.deepEqual(p.conflicts, []);
  const r = row(p, 'index.html');
  assert.equal(r.action, 'replace');
  assert.equal(r.from, 0);
  assert.equal(r.remaining, 2);
  assert.equal(r.uploadBytes, 30000);
  assert.deepEqual(stepsOf(p).map((s) => s.index), [0, 1]);
  const other = file('page.html', 30000);
  const q = planPublish([other], [bad(other)]);
  assert.deepEqual(q.conflicts.map((x) => [x.path, x.reason]), [['page.html', 'corrupt']]);
  assert.deepEqual(q.rows, []);
});

test('stepsOf：多块的新文件从第 0 块开始', () => {
  const p = planPublish([file('big.png', 60000)], [null]);
  assert.deepEqual(stepsOf(p).map((s) => s.index), [0, 1, 2]);
});
