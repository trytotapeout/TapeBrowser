import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageAudit } from '../src/main/page-audit.js';

const memStore = () => { const m = new Map(); return { get: (o) => m.get(o) ?? null, set: (o, v) => m.set(o, v), m }; };
const SITE = 'tape://1-2-248';

test('签名基线：第一次没有基线；同意后记下；之后改过的文件会列出来，新加载的文件不算改过', () => {
  const store = memStore();
  const a = createPageAudit(store);
  a.file(SITE, 'index.html', '0xAA');
  a.file(SITE, 'app.js', '0xbb');
  assert.deepEqual(a.compare(SITE), { first: true, changed: [] });
  a.commit(SITE);
  assert.deepEqual(store.get(SITE), { 'index.html': '0xaa', 'app.js': '0xbb' });
  // 重启后：只加载了首页和一个新文件，app.js 没加载
  const b = createPageAudit(store);
  b.file(SITE, 'index.html', '0xaa');
  b.file(SITE, 'other.js', '0x11');
  assert.deepEqual(b.compare(SITE), { first: false, changed: [] });
  // app.js 换了内容
  b.file(SITE, 'app.js', '0xcc');
  assert.deepEqual(b.compare(SITE).changed, ['app.js']);
  // 没同意（没 commit）时基线不变，下次还会提醒
  assert.deepEqual(b.compare(SITE).changed, ['app.js']);
  b.commit(SITE);
  assert.deepEqual(b.compare(SITE).changed, []);
  // 合并保存：保留没加载到的文件
  assert.equal(store.get(SITE)['other.js'], '0x11');
});

test('外部资源：按 origin 分组，脚本和接口标为危险并排在前面；刷新后清空', () => {
  const a = createPageAudit(memStore());
  a.external(SITE, 'https://fonts.example.com/a.woff2', 'font');
  a.external(SITE, 'https://cdn.example.com/x.js', 'script');
  a.external(SITE, 'https://cdn.example.com/y.js', 'script');
  a.external(SITE, 'not a url', 'script');
  const list = a.externalOf(SITE);
  assert.deepEqual(list.map((e) => [e.origin, e.risky, e.count]), [['https://cdn.example.com', true, 2], ['https://fonts.example.com', false, 1]]);
  a.reset(SITE);
  assert.deepEqual(a.externalOf(SITE), []);
});
