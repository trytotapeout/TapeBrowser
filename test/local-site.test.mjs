import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSites, parseLocalHost, isLocalUrl } from '../src/main/local-site.js';
import { createTapeHandler } from '../src/main/tape-protocol.js';
import { parseHost, parseInput } from '../src/main/address.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'tb-local-'));
  const root = join(base, 'site');
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'index.html'), '<title>Hi</title>');
  await writeFile(join(root, 'docs/index.html'), 'docs');
  await writeFile(join(root, 'app.js'), 'x');
  await writeFile(join(root, '.env'), 'SECRET=1');
  await writeFile(join(root, '.git/config'), 'x');
  await writeFile(join(base, 'outside.txt'), 'outside');
  await symlink(join(base, 'outside.txt'), join(root, 'link.txt'));
  return { base, root };
}

test('本地主机名不会被当成电路', () => {
  assert.equal(parseLocalHost('local-0123456789ab'), '0123456789ab');
  assert.equal(parseLocalHost('local-xyz'), null);
  assert.equal(parseHost('local-0123456789ab'), null);
  assert.ok(isLocalUrl('tape://local-0123456789ab/a.js'));
  assert.ok(!isLocalUrl('tape://4454-0/'));
  assert.notEqual(parseInput('tape://local-0123456789ab/').kind, 'site');
});

test('同一个文件夹 id 固定；只读文件夹里的普通文件', async () => {
  const { base, root } = await fixture();
  try {
    const local = createLocalSites();
    const a = await local.add(root);
    const b = await local.add(root + '/');
    assert.equal(a.id, b.id);
    assert.equal(local.rootOf(a.url + 'x.js'), a.root);
    assert.equal(local.rootOf('tape://local-000000000000/'), null);

    const f = await local.readLocal(a.root, 'index.html');
    assert.equal(new TextDecoder().decode(f.bytes), '<title>Hi</title>');
    assert.match(f.info.sha256, /^0x[0-9a-f]{64}$/);
    assert.equal(f.source, 'local');
    for (const p of ['.env', '.git/config', '../outside.txt', 'docs/../../outside.txt', 'link.txt', 'docs', '/etc/passwd', 'a\\b']) {
      assert.equal(await local.readLocal(a.root, p), null, p);
    }

    const l = await local.list(a.root);
    assert.deepEqual(l.files.map((x) => x.path), ['app.js', 'docs/index.html', 'index.html']);
    assert.deepEqual(l.skipped.sort(), ['.env', '.git/', 'link.txt', 'node_modules/']);
    assert.equal(l.truncated, false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('tape:// 处理器按同样的规则返回本地文件', async () => {
  const { base, root } = await fixture();
  try {
    const local = createLocalSites();
    const { url } = await local.add(root);
    const served = [];
    const handle = createTapeHandler({}, { local, onServe: (o, p) => served.push(p) });
    const get = (u) => handle(new Request(u));

    const r = await get(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('x-tape-source'), 'local');
    assert.equal((await get(url + 'docs')).status, 301);
    assert.equal((await get(url + '.env')).status, 404);
    assert.equal((await get(url + 'nope.js')).status, 404);
    assert.equal((await get('tape://local-000000000000/')).status, 404);
    assert.deepEqual(served, ['index.html']);
  } finally { await rm(base, { recursive: true, force: true }); }
});
