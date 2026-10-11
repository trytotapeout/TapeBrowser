import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFeed, createTapeCode, FEED_API } from '../src/main/tapecode.js';

const post = (id, app, bumped, extra = {}) => ({ id, title: 't' + id, app, at: bumped, bumped, author: { addr: '0x1' }, ...extra });

test('parseFeed：各种网站名，写错的跳过，cursor 取最小的 bumped', () => {
  const r = parseFeed({
    posts: [post(1, '1413.30.tape', 30), post(2, '1.2.282.tape', 20), post(3, null, 10), post(4, 'abc', 15), post(5, '1.1215', 25, { title: 'a\nb' })],
    more: true,
  });
  assert.deepEqual(r.apps.map((a) => a.host), ['1413-30', '1-2-282', '1-1215']);
  assert.equal(r.apps[2].title, 'a b');
  assert.equal(r.cursor, 10);
  assert.equal(r.more, true);
  assert.throws(() => parseFeed({ error: 'E_NOT_FOUND' }));
});

function fakeFetch(pages, calls) {
  return async (url) => {
    calls.push(url);
    const before = new URL(url).searchParams.get('before');
    const body = pages[before ?? ''];
    if (!body) return { ok: false, status: 500 };
    return { ok: true, json: async () => body };
  };
}

test('createTapeCode：翻完所有页、同一网站取最早的分享、写缓存、重启后可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-'));
  try {
    const file = join(dir, 'tapecode.json');
    const calls = [];
    const pages = {
      '': { posts: [post(9, '1413.30.tape', 90), post(8, '1.2.282.tape', 80)], more: true },
      80: { posts: [post(2, '1413.30.tape', 20)], more: false },
    };
    let changes = 0;
    const tc = createTapeCode({ file, fetchImpl: fakeFetch(pages, calls), onChange: () => changes++ });
    await tc.refresh();
    assert.deepEqual(calls, [FEED_API, FEED_API + '&before=80']);
    assert.equal(tc.shared(1413, 30).post, 2);
    assert.equal(tc.shared(1, 282, 2).post, 8);
    assert.equal(tc.shared(1, 282), null, 'BNB 上的 1.282 不算');
    assert.equal(changes, 1);
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).apps['1413-30']);
    // 不到一小时不重读
    await tc.refresh();
    assert.equal(calls.length, 2);
    // 重启：读不到接口也用缓存
    const again = createTapeCode({ file, fetchImpl: fakeFetch({}, []) });
    await again.refresh({ force: true });
    assert.equal(again.shared(1413, 30).post, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createTapeCode：中途翻页失败保留上次结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-'));
  try {
    const file = join(dir, 'tapecode.json');
    const ok = createTapeCode({ file, fetchImpl: fakeFetch({ '': { posts: [post(1, '1413.30.tape', 10)], more: false } }, []) });
    await ok.refresh();
    const broken = createTapeCode({ file, fetchImpl: fakeFetch({ '': { posts: [post(5, '15324.30.tape', 50)], more: true } }, []) });
    await broken.refresh({ force: true });
    assert.equal(broken.shared(1413, 30).post, 1);
    assert.equal(broken.shared(15324, 30), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
