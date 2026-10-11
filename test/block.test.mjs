import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlock, blockReason } from '../src/main/block.js';
import { createTapeHandler } from '../src/main/tape-protocol.js';

test('parseBlock：各种写法，写错的条目跳过', () => {
  const d = parseBlock({ version: 1, sites: [{ site: '15016.30', reason: '仿冒' }, '1.2.344', { site: '8888.0.tape' }, { site: 'tape://4454-0/' }, { site: '0.1' }, { site: 'abc' }, 42, null] });
  assert.deepEqual(d, { sites: { '15016-30': '仿冒', '1-2-344': '', '8888-0': '' } });
  assert.equal(parseBlock({ sites: [] }), null);
  assert.equal(parseBlock({}), null);
});

test('blockReason', () => {
  const c = { data: parseBlock({ sites: [{ site: '15016.30', reason: '仿冒' }, '1.2.344'] }), readAt: 0 };
  assert.equal(blockReason(c, 15016, 30), '仿冒');
  assert.equal(blockReason(c, 1, 344, 2), '');
  assert.equal(blockReason(c, 1, 344), null, 'BNB 上的 1.344 不受影响');
  assert.equal(blockReason(c, 4454, 0), null);
  assert.equal(blockReason(null, 15016, 30), null);
  assert.equal(blockReason({ data: null, readAt: 0 }, 15016, 30), null);
});

test('tape:// 打开屏蔽的网站显示已屏蔽，不读链', async () => {
  let reads = 0;
  const sites = {
    site: async () => { reads++; return { exists: true, opened: true, container: '0xc' }; },
    readFile: async () => { reads++; return { bytes: new TextEncoder().encode('hi'), info: { sha256: '0x1' } }; },
  };
  const c = { data: parseBlock({ sites: [{ site: '15016.30', reason: '仿冒网站' }] }), readAt: 0 };
  const handle = createTapeHandler(sites, { blocked: (t, cpu, a) => blockReason(c, t, cpu, a) });
  const r = await handle(new Request('tape://15016-30/'));
  assert.equal(r.status, 403);
  assert.match(await r.text(), /15016\.30\.tape 已被屏蔽[\s\S]*仿冒网站/);
  assert.equal((await handle(new Request('tape://15016-30/app.js'))).status, 403);
  // 没写原因：只说打开出错，不提屏蔽
  const quiet = createTapeHandler(sites, { blocked: () => '' });
  const q = await (await quiet(new Request('tape://15016-30/'))).text();
  assert.match(q, /打开这个网站发生了错误。/);
  assert.doesNotMatch(q, /屏蔽/);
  assert.equal(reads, 0);
  assert.equal((await handle(new Request('tape://4454-0/'))).status, 200);
});
