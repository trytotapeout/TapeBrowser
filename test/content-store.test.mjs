import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createContentStore } from '../src/main/content-store.js';
import { createSites } from '../src/main/sites.js';

const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
const enc = (s) => new TextEncoder().encode(s);
const tmp = () => mkdtempSync(join(tmpdir(), 'tb-cache-'));

test('按 sha256 存取，重启后还能读到', async () => {
  const dir = tmp();
  const a = enc('<h1>hello</h1>');
  const s1 = createContentStore(dir);
  await s1.put(sha(a), a);
  assert.deepEqual(await s1.get(sha(a)), a);
  const s2 = createContentStore(dir);
  assert.deepEqual(Buffer.from(await s2.get(sha(a))), Buffer.from(a));
  assert.deepEqual(await s2.usage(), { bytes: a.length, files: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test('磁盘内容被改动时校验失败，当作没有缓存并删除', async () => {
  const dir = tmp();
  const a = enc('original');
  const h = sha(a);
  await createContentStore(dir).put(h, a);
  writeFileSync(join(dir, 'blobs', h.slice(2, 4), h.slice(2)), 'tampered');
  const s = createContentStore(dir);
  assert.equal(await s.get(h), null);
  assert.deepEqual(readdirSync(join(dir, 'blobs', h.slice(2, 4))), []);
  rmSync(dir, { recursive: true, force: true });
});

test('超过上限时淘汰最久没用的', async () => {
  const dir = tmp();
  const s = createContentStore(dir, { maxBytes: 25 });
  const items = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'].map(enc);
  for (const b of items) { await s.put(sha(b), b); await new Promise((r) => setTimeout(r, 5)); }
  const u = await s.usage();
  assert.ok(u.bytes <= 25, `bytes=${u.bytes}`);
  // 最新的一定还在（重新打开绕过内存层）
  assert.ok(await createContentStore(dir).get(sha(items[2])));
  rmSync(dir, { recursive: true, force: true });
});

test('clear 清空', async () => {
  const dir = tmp();
  const s = createContentStore(dir);
  const a = enc('x');
  await s.put(sha(a), a);
  s.rememberFile('0xC', 'index.html', { sha256: sha(a) });
  await s.clear();
  assert.deepEqual(await s.usage(), { bytes: 0, files: 0 });
  assert.equal(s.lastFile('0xc', 'index.html'), null);
  assert.equal(await createContentStore(dir).get(sha(a)), null);
  rmSync(dir, { recursive: true, force: true });
});

// sites 接上磁盘缓存：网站更新后用新内容；读链失败时用上次的版本
function fakeChain(files) {
  let down = false;
  let downloads = 0;
  const chain = {
    setDown(v) { down = v; },
    downloads: () => downloads,
    async cpuList() { if (down) throw new Error('rpc down'); return ['0xcircuits']; },
    async circuitInfos(items) { if (down) throw new Error('rpc down'); return items.map(() => ({ exists: true, owner: '0xowner', container: '0xc', opened: true })); },
    async fileInfo(_c, path) {
      if (down) throw new Error('rpc down');
      const b = files[path];
      return b ? { size: b.length, contentType: 'text/html', sha256: sha(b), updatedAt: 1, chunkCount: 1 } : null;
    },
    async readVerified(_c, path) { downloads++; return files[path]; },
  };
  return chain;
}

test('网站更新后读到新内容；没变的文件不重新下载', async () => {
  const dir = tmp();
  const files = { 'index.html': enc('v1') };
  const chain = fakeChain(files);
  const sites = createSites(chain, createContentStore(dir));
  assert.equal((await sites.readFile('0xc', 'index.html')).source, 'chain');
  const again = await sites.readFile('0xc', 'index.html');
  assert.equal(again.source, 'cache');
  assert.equal(chain.downloads(), 1);
  files['index.html'] = enc('v2');
  const updated = await sites.readFile('0xc', 'index.html');
  assert.equal(new TextDecoder().decode(updated.bytes), 'v2');
  assert.equal(updated.source, 'chain');
  // 换一个进程（新的 sites）也能命中磁盘缓存
  const sites2 = createSites(chain, createContentStore(dir));
  assert.equal((await sites2.readFile('0xc', 'index.html')).source, 'cache');
  assert.equal(chain.downloads(), 2);
  rmSync(dir, { recursive: true, force: true });
});

test('读链失败时用上次缓存的版本，标记 stale；没缓存过的照样报错', async () => {
  const dir = tmp();
  const chain = fakeChain({ 'index.html': enc('hello'), 'b.html': enc('b') });
  const store = createContentStore(dir);
  const sites = createSites(chain, store);
  await sites.site(4454, 0);
  await sites.readFile('0xc', 'index.html');
  store.flush();
  chain.setDown(true);
  const offline = createSites(chain, createContentStore(dir));
  const s = await offline.site(4454, 0);
  assert.equal(s.stale, true);
  assert.equal(s.container, '0xc');
  const f = await offline.readFile('0xc', 'index.html');
  assert.equal(f.source, 'stale');
  assert.equal(new TextDecoder().decode(f.bytes), 'hello');
  await assert.rejects(offline.readFile('0xc', 'b.html'), /rpc down/);
  const d = await offline.describe(4454, 0, 'index.html');
  assert.equal(d.file.source, 'stale');
  rmSync(dir, { recursive: true, force: true });
});
