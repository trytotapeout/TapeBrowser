import test from 'node:test';
import assert from 'node:assert/strict';
import { shareLink, gatewayLink, shortTitle, xIntentUrl, HASHTAGS } from '../src/main/share.js';

test('shareLink：合法地址拼成落地页链接，去掉 .tape，首页不带路径', () => {
  assert.equal(shareLink('4454.0.tape'), 'https://trytotapeout.github.io/TapeBrowser/open/?4454.0');
  assert.equal(shareLink('1.2.248'), 'https://trytotapeout.github.io/TapeBrowser/open/?1.2.248');
  assert.equal(shareLink('4454.0', '/index.html'), 'https://trytotapeout.github.io/TapeBrowser/open/?4454.0');
  assert.equal(shareLink('4454.0', '/docs/a.html'), 'https://trytotapeout.github.io/TapeBrowser/open/?4454.0/docs/a.html');
});

test('shareLink：不合法的地址和路径', () => {
  for (const bad of ['', null, '0.1', '04.1', 'https://evil.com', '4454.0&x=1', '4454']) assert.equal(shareLink(bad), null, bad);
  assert.equal(shareLink('4454.0', '/a?b=1'), 'https://trytotapeout.github.io/TapeBrowser/open/?4454.0');
});

test('shortTitle：去掉换行，按字符截断', () => {
  assert.equal(shortTitle('  a\n b  '), 'a b');
  const long = '😀'.repeat(80);
  assert.equal(Array.from(shortTitle(long)).length, 60);
  assert.ok(shortTitle(long).endsWith('…'));
});

test('xIntentUrl：只指向 x.com，参数编码', () => {
  const u = new URL(xIntentUrl('「A & B」 #DeWEB', 'https://trytotapeout.github.io/TapeBrowser/open/?4454.0'));
  assert.equal(u.origin + u.pathname, 'https://x.com/intent/post');
  assert.equal(u.searchParams.get('text'), '「A & B」 #DeWEB');
  assert.equal(u.searchParams.get('url'), 'https://trytotapeout.github.io/TapeBrowser/open/?4454.0');
});

test('xIntentUrl：不传 link 时没有 url 参数，链接和话题标签都在正文里', () => {
  const text = '看看 https://4454-0.tapekit.org/\n\n' + HASHTAGS;
  const u = new URL(xIntentUrl(text));
  assert.equal(u.searchParams.get('url'), null);
  assert.equal(u.searchParams.get('text'), text);
  assert.ok(u.searchParams.get('text').endsWith('#tapeout #tapekit #bem'));
});

test('gatewayLink：官方网关子域名，三条链和路径', () => {
  assert.equal(gatewayLink('1.1208.tape'), 'https://1-1208.tapekit.org/');
  assert.equal(gatewayLink('4454.0'), 'https://4454-0.tapekit.org/');
  assert.equal(gatewayLink('1.2.344.tape'), 'https://1-2-344.tapekit.org/');
  assert.equal(gatewayLink('1.3.5', '/docs/a.html'), 'https://1-3-5.tapekit.org/docs/a.html');
  assert.equal(gatewayLink('1.3.5', '/index.html'), 'https://1-3-5.tapekit.org/');
  assert.equal(gatewayLink('evil.com'), null);
});
