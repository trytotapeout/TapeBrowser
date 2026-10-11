import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAds, cleanLink, cleanImage, expired, adsView, adImage, MAX_STALE } from '../src/main/ads.js';

const AD = { title: '某应用', desc: '介绍', image: 'ads/home.png', link: 'tape://4454-0/' };
const T0 = new Date(2026, 9, 10, 12).getTime();
const cached = (raw, readAt = T0) => ({ data: parseAds(raw), readAt });

test('parseAds：两个位置各自校验', () => {
  const d = parseAds({ version: 1, slots: { home: AD, panel: null } });
  assert.deepEqual(d.slots.home, { ...AD, until: null });
  assert.equal(d.slots.panel, null);
  assert.equal(d.placeholder, null);
  const r = parseAds({ slots: { home: { ...AD, link: 'javascript:alert(1)' }, panel: AD } });
  assert.equal(r.slots.home, null);
  assert.ok(r.slots.panel);
  for (const bad of [{ ...AD, title: '' }, { ...AD, title: 'x'.repeat(41) }, { ...AD, image: '../x.png' }, { ...AD, until: '明天' }, { ...AD, desc: 3 }]) {
    assert.equal(parseAds({ slots: { home: bad } }).slots.home, null, JSON.stringify(bad));
  }
  // 没有图片也可以
  assert.equal(parseAds({ slots: { home: { title: 't', link: 'https://a.example' } } }).slots.home.image, null);
});

test('cleanLink / cleanImage / expired', () => {
  assert.equal(cleanLink('https://a.example/x'), 'https://a.example/x');
  assert.equal(cleanLink('tape://1-1196/'), 'tape://1-1196/');
  for (const bad of ['http://a.example', 'javascript:1', 'file:///etc/passwd', 'data:text/html,1', '']) assert.equal(cleanLink(bad), null, bad);
  assert.equal(cleanImage('ads/a.webp'), 'ads/a.webp');
  for (const bad of ['/ads/a.png', 'ads/../a.png', 'https://x/a.png', 'ads/a.svg', 'ads//a.png', 'a\\b.png']) assert.equal(cleanImage(bad), null, bad);
  const day = new Date(2026, 9, 10, 23, 59).getTime();
  assert.equal(expired({ until: '2026-10-10' }, day), false);
  assert.equal(expired({ until: '2026-10-10' }, new Date(2026, 9, 11, 0, 0).getTime()), true);
  assert.equal(expired({ until: null }, day), false);
});

test('adsView：广告、招租、过期、太久没读到', () => {
  assert.deepEqual(adsView(null, T0), { home: null, panel: null });
  assert.deepEqual(adsView({ data: null, readAt: T0 }, T0), { home: null, panel: null });
  const c = cached({ slots: { home: { ...AD, until: '2026-10-10' } }, placeholder: { title: '广告位招租', desc: '', link: 'tape://1-1196/' } });
  assert.equal(adsView(c, T0).home.kind, 'ad');
  assert.equal(adsView(c, T0).home.image, true);
  assert.deepEqual(adsView(c, T0).panel, { kind: 'placeholder', title: '广告位招租', desc: '', link: 'tape://1-1196/' });
  assert.equal(adsView(c, new Date(2026, 9, 11, 1).getTime()).home.kind, 'placeholder');
  assert.deepEqual(adsView(c, T0 + MAX_STALE + 1), { home: null, panel: null });
});

test('adImage：只读当前显示的广告图片，太大不要', async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const c = cached({ slots: { home: AD, panel: { ...AD, image: 'ads/p.png', until: '2026-10-01' } } });
  const read = async (path) => (path === 'ads/home.png' ? { bytes: png } : path === 'ads/p.png' ? { bytes: png } : null);
  assert.deepEqual(await adImage(c, 'home', read, T0), { bytes: png, type: 'image/png' });
  assert.equal(await adImage(c, 'panel', read, T0), null, '过期了');
  assert.equal(await adImage(c, 'other', read, T0), null);
  assert.equal(await adImage(c, 'home', async () => ({ bytes: new Uint8Array(600 * 1024) }), T0), null);
  assert.equal(await adImage(c, 'home', async () => { throw new Error('x'); }, T0), null);
});
