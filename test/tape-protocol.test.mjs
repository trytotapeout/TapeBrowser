import test from 'node:test';
import assert from 'node:assert/strict';
import { createTapeHandler } from '../src/main/tape-protocol.js';

const files = {
  'index.html': '<h1>hi</h1>',
  'docs/index.html': 'docs',
  'app.js': 'x',
};

const sites = {
  async site(tokenId, cpu) {
    if (tokenId === 4454 && cpu === 0) return { exists: true, opened: true, container: '0xc' };
    if (tokenId === 1 && cpu === 0) return { exists: true, opened: false, container: null };
    if (tokenId === 9 && cpu === 0) throw new Error('rpc down');
    return { exists: false };
  },
  async readFile(_c, path) {
    if (!(path in files)) return null;
    return { bytes: new TextEncoder().encode(files[path]), info: { sha256: '0xab', contentType: path === 'app.js' ? '' : null } };
  },
};

const handle = createTapeHandler(sites);
const get = (url, method = 'GET') => handle(new Request(url, { method }));

test('首页与文件', async () => {
  const r = await get('tape://4454-0/');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('x-tape-sha256'), '0xab');
  assert.equal(await r.text(), '<h1>hi</h1>');
  const js = await get('tape://4454-0/app.js');
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('目录补斜杠 301', async () => {
  const r = await get('tape://4454-0/docs?a=1');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/docs/?a=1');
  assert.equal((await get('tape://4454-0/docs/')).status, 200);
});

test('HEAD 无正文', async () => {
  const r = await get('tape://4454-0/', 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), '11');
});

test('错误状态', async () => {
  assert.equal((await get('tape://4454-0/nope.png')).status, 404);
  assert.equal((await get('tape://1-0/')).status, 404);
  assert.equal((await get('tape://2-0/')).status, 404);
  assert.equal((await get('tape://9-0/')).status, 502);
  assert.equal((await get('tape://abc/')).status, 400);
  assert.equal((await get('tape://4454-0/', 'POST')).status, 405);
});
