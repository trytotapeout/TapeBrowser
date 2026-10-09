import test from 'node:test';
import assert from 'node:assert/strict';
import { precheck, imageSize, referencesOf, resolveRef, txsOf } from '../src/main/precheck.js';

const enc = (s) => new TextEncoder().encode(s);

/** 内存里的文件夹：{path: string | Uint8Array} */
function folder(map) {
  const files = Object.entries(map).map(([path, v]) => ({ path, size: (typeof v === 'string' ? enc(v) : v).length }));
  const read = async (p) => (p in map ? (typeof map[p] === 'string' ? enc(map[p]) : map[p]) : null);
  return { files, read };
}

function png(w, h, size = 64) {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

const levels = (r) => r.items.map((i) => i.level);
const texts = (r, level) => r.items.filter((i) => i.level === level).map((i) => i.text).join('\n');

test('交易笔数：每 24 KB 一笔', () => {
  assert.equal(txsOf(1), 1);
  assert.equal(txsOf(24000), 1);
  assert.equal(txsOf(24001), 2);
});

test('图片尺寸', () => {
  assert.deepEqual(imageSize(png(256, 256)), { type: 'png', width: 256, height: 256 });
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x90, 0x02, 0x80, 3, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { type: 'jpeg', width: 640, height: 400 });
  assert.equal(imageSize(enc('hello')), null);
});

test('引用解析', () => {
  const refs = referencesOf('<script src="./a.js"></script><a href="https://x.com">x</a><img src="data:a"><link href="#x">', false);
  assert.deepEqual(refs, [{ tag: 'script', ref: './a.js' }, { tag: 'a', ref: 'https://x.com' }]);
  assert.deepEqual(referencesOf('a{background:url("img/b.png")}@import "c.css";', true).map((r) => r.ref), ['img/b.png', 'c.css']);
  assert.deepEqual(resolveRef('docs/index.html', '../a.js?v=1'), { path: 'a.js' });
  assert.deepEqual(resolveRef('index.html', '/assets/'), { path: 'assets/index.html' });
  assert.deepEqual(resolveRef('index.html', 'https://cdn.example.com/x.js'), { external: 'https://cdn.example.com' });
});

test('干净的网站只有提示，卡片信息齐全', async () => {
  const { files, read } = folder({
    'index.html': '<title>Gomoku</title><script src="app.js"></script><link rel="icon" href="/logo.png">',
    'app.js': 'x',
    'logo.png': png(256, 256),
    'deweb.json': '{"category": "game"}',
  });
  const r = await precheck({ files, read });
  assert.ok(!levels(r).includes('error') && !levels(r).includes('warn'), JSON.stringify(r.items));
  assert.equal(r.card.title, 'Gomoku');
  assert.equal(r.card.category, 'game');
  assert.equal(r.card.categoryFrom, 'declared');
  assert.equal(r.card.logo.width, 256);
  assert.deepEqual(r.summary, { files: 4, bytes: files.reduce((s, f) => s + f.size, 0), txs: 4 });
});

test('传不上去的情况是错误', async () => {
  const { files, read } = folder({ 'app.js': '', 'a?b.js': 'x' });
  const r = await precheck({ files, read, truncated: false });
  const e = texts(r, 'error');
  assert.match(e, /index\.html/);
  assert.match(e, /空文件/);
  assert.match(e, /a\?b\.js/);
  const big = await precheck({ files: [{ path: 'index.html', size: 10 }, { path: 'v.mp4', size: 9_000_000 }], read: async () => enc('<title>x</title>') });
  assert.match(texts(big, 'error'), /v\.mp4/);
});

test('缺文件、外部脚本、首页太大、图片超限是警告', async () => {
  const { files, read } = folder({
    'index.html': '<title>x</title><script src="https://cdn.example.com/lib.js"></script><script src="missing.js"></script><img src="https://img.example.com/a.png"><a href="https://x.com">x</a>',
    'cover.png': png(640, 400, 60 * 1024),
  });
  const r = await precheck({ files, read, skipped: ['node_modules/'] });
  const w = texts(r, 'warn');
  assert.match(w, /missing\.js/);
  assert.match(w, /cdn\.example\.com/);
  assert.match(w, /cover\.png.*50 KB/);
  assert.match(w, /node_modules/);
  assert.doesNotMatch(w, /x\.com/);
  assert.match(texts(r, 'info'), /img\.example\.com/);
  assert.equal(r.card.cover, null);

  const fat = folder({ 'index.html': '<title>x</title>' + 'a'.repeat(300 * 1024) });
  assert.match(texts(await precheck(fat), 'warn'), /256 KB/);
});

test('运行时加载的外部脚本也算进去', async () => {
  const { files, read } = folder({ 'index.html': '<title>x</title>' });
  const r = await precheck({ files, read, external: [{ origin: 'https://api.example.com', risky: true }] });
  assert.match(texts(r, 'warn'), /api\.example\.com/);
});

test('deweb.json 不合法、logo 比例不对', async () => {
  const { files, read } = folder({ 'index.html': '<title>x</title>', 'deweb.json': '{"category": "nope"}', 'logo.png': png(300, 100) });
  const r = await precheck({ files, read });
  assert.match(texts(r, 'warn'), /web\.json/);
  assert.match(texts(r, 'info'), /300×100/);
  assert.equal(r.card.categoryFrom, 'guess');
});

test('首页超过一块：更新时要分几笔替换，替换完成前网站打不开，警告里写字节数和笔数', async () => {
  const page = (size) => folder({ 'index.html': '<title>x</title>' + 'a'.repeat(size - 16) });
  const big = texts(await precheck(page(30000)), 'warn');
  assert.match(big, /30000 字节/);
  assert.match(big, /24000 字节/);
  assert.match(big, /分 2 笔交易替换/);
  assert.match(big, /网站会暂时打不开/);
  assert.doesNotMatch(texts(await precheck(page(24000)), 'warn'), /超过一块/);
  assert.match(texts(await precheck(page(24001)), 'warn'), /24001 字节，超过一块的 24000 字节。更新网站时首页要分 2 笔交易替换/);
  assert.match(texts(await precheck(page(60000)), 'warn'), /60000 字节，超过一块的 24000 字节。更新网站时首页要分 3 笔交易替换/);
  const small = folder({ 'index.html': '<title>x</title>' });
  assert.doesNotMatch(texts(await precheck(small), 'warn'), /超过一块/);
});
