import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibrary, tapeSite } from '../src/main/library.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tb-lib-'));
  const file = join(dir, 'library.json');
  let t = 1000;
  let changes = 0;
  const lib = createLibrary(file, { now: () => ++t, onChange: () => changes++ });
  return { lib, file, changes: () => changes, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('tapeSite 规范化电路网址', () => {
  assert.deepEqual(tapeSite('tape://4454-0/docs/a.html'), { origin: 'tape://4454-0', label: '4454.0.tape' });
  assert.equal(tapeSite('https://example.com'), null);
  assert.equal(tapeSite('tape://abc/'), null);
});

test('历史按网站去重，最近访问在前，只记电路网站', () => {
  const { lib, done } = setup();
  lib.visit('tape://4454-0/');
  lib.visit('tape://4453-0/zh-cn/index.html');
  lib.visit('tape://4454-0/docs/');
  lib.visit('https://example.com/');
  const h = lib.history();
  assert.deepEqual(h.map((e) => e.url), ['tape://4454-0/', 'tape://4453-0/']);
  assert.equal(h[0].visits, 2);
  assert.equal(h[0].label, '4454.0.tape');
  done();
});

test('标题更新落到对应网站；空标题和网址本身不覆盖', () => {
  const { lib, done } = setup();
  lib.visit('tape://4454-0/');
  lib.title('tape://4454-0/about.html', 'TapeVault');
  lib.title('tape://4454-0/', 'tape://4454-0/');
  lib.title('tape://4454-0/', '  ');
  assert.equal(lib.history()[0].title, 'TapeVault');
  lib.title('tape://9-9/', 'nobody');
  assert.equal(lib.history().length, 1);
  done();
});

test('删除、清空历史', () => {
  const { lib, done } = setup();
  lib.visit('tape://1-0/');
  lib.visit('tape://2-0/');
  lib.removeHistory('tape://1-0/');
  assert.deepEqual(lib.history().map((e) => e.url), ['tape://2-0/']);
  lib.clearHistory();
  assert.deepEqual(lib.history(), []);
  done();
});

test('书签切换，只接受 http/https/tape', () => {
  const { lib, done } = setup();
  assert.equal(lib.toggleBookmark('tape://4454-0/docs/', 'Docs'), true);
  assert.equal(lib.toggleBookmark('https://example.com/', ''), true);
  assert.equal(lib.toggleBookmark('javascript:alert(1)', 'x'), false);
  assert.equal(lib.toggleBookmark('file:///etc/passwd', 'x'), false);
  const b = lib.bookmarks();
  assert.deepEqual(b.map((x) => x.url), ['https://example.com/', 'tape://4454-0/docs/']);
  assert.equal(b[0].title, 'https://example.com/');
  assert.equal(b[1].label, '4454.0.tape');
  assert.equal(lib.isBookmarked('tape://4454-0/docs/'), true);
  assert.equal(lib.toggleBookmark('tape://4454-0/docs/'), false);
  assert.equal(lib.isBookmarked('tape://4454-0/docs/'), false);
  done();
});

test('flush 写盘后能重新读出，坏数据被丢弃', () => {
  const { lib, file, done } = setup();
  lib.visit('tape://4454-0/');
  lib.toggleBookmark('tape://4453-0/', 'Blonskr');
  lib.flush();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.history.length, 1);
  const again = createLibrary(file);
  assert.equal(again.history()[0].url, 'tape://4454-0/');
  assert.equal(again.bookmarks()[0].title, 'Blonskr');
  done();
});

test('历史最多保留 200 个网站', () => {
  const { lib, done } = setup();
  for (let i = 1; i <= 210; i++) lib.visit(`tape://${i}-0/`);
  const h = lib.history();
  assert.equal(h.length, 200);
  assert.equal(h[0].url, 'tape://210-0/');
  done();
});
