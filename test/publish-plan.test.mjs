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

test('首页内容变了：小于一块就最后替换，太大就算冲突', () => {
  const oldIndex = file('index.html', 100, 1);
  const small = file('index.html', 100, 2);
  const p = planPublish([small], [onChain(oldIndex, 1, 'text/html; charset=utf-8')]);
  assert.equal(row(p, 'index.html').action, 'replace');
  assert.equal(row(p, 'index.html').remaining, 1);
  const big = file('index.html', CHUNK_BYTES + 1, 2);
  const q = planPublish([big], [onChain(oldIndex, 1, 'text/html; charset=utf-8')]);
  assert.equal(q.conflicts[0].path, 'index.html');
  assert.equal(q.conflicts[0].reason, 'index-too-big');
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
