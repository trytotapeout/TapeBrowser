import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAdsHtml, cleanLink, cleanImage, expired, createAds, AD_CONTAINER, MAX_STALE, REFRESH_ON_VIEW } from '../src/main/ads.js';

const page = (obj) => `<!doctype html><html><head><script type="application/json" id="tape-ads">${typeof obj === 'string' ? obj : JSON.stringify(obj)}</script></head><body><div data-slot="home"></div></body></html>`;
const AD = { title: '某应用', desc: '介绍', image: 'ads/home.png', link: 'tape://4454-0/' };

test('parseAdsHtml：ok / none / bad', () => {
  const r = parseAdsHtml(page({ version: 1, slots: { home: AD, panel: null } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data.slots.home, { ...AD, until: null });
  assert.equal(r.data.slots.panel, null);
  assert.equal(r.data.placeholder, null);
  assert.equal(parseAdsHtml('<html><body>换成别的首页</body></html>').status, 'none');
  assert.equal(parseAdsHtml(page('{坏的')).status, 'bad');
  assert.equal(parseAdsHtml(page({ version: 2, slots: {} })).status, 'bad');
});

test('单个广告位不合格只隐藏这一个', () => {
  const r = parseAdsHtml(page({ version: 1, slots: { home: { ...AD, link: 'javascript:alert(1)' }, panel: AD } }));
  assert.equal(r.data.slots.home, null);
  assert.ok(r.data.slots.panel);
  for (const bad of [{ ...AD, title: '' }, { ...AD, title: 'x'.repeat(41) }, { ...AD, image: '../x.png' }, { ...AD, until: '明天' }, { ...AD, desc: 3 }]) {
    assert.equal(parseAdsHtml(page({ version: 1, slots: { home: bad } })).data.slots.home, null, JSON.stringify(bad));
  }
  // 没有图片也可以
  assert.equal(parseAdsHtml(page({ version: 1, slots: { home: { title: 't', link: 'https://a.example' } } })).data.slots.home.image, null);
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

/** 假的 sites：files 是 {path: string|bytes}；fail 为 true 时读链抛错 */
function fakeSites(state) {
  return {
    site: async () => { if (state.fail) throw new Error('rpc down'); return { exists: true, opened: true, container: state.container ?? AD_CONTAINER }; },
    readFile: async (_c, path) => {
      if (state.fail) throw new Error('rpc down');
      const v = state.files[path];
      if (v === undefined) return null;
      return { bytes: typeof v === 'string' ? new TextEncoder().encode(v) : v, info: {}, source: 'chain' };
    },
  };
}

function setup(state, t0 = 1_800_000_000_000) {
  const dir = mkdtempSync(join(tmpdir(), 'ads-'));
  const clock = { t: t0 };
  const changes = [];
  const make = () => createAds({ sites: fakeSites(state), file: join(dir, 'ads.json'), now: () => clock.t, onChange: (v) => changes.push(v) });
  return { dir, clock, changes, make, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('读到广告 → 显示；撤掉广告 → 立即消失；读取失败 → 保留上次的', async () => {
  const state = { files: { 'index.html': page({ version: 1, slots: { home: AD } }) } };
  const s = setup(state);
  const ads = s.make();
  assert.deepEqual(ads.view(), { home: null, panel: null });
  assert.equal(await ads.refresh(), 'ok');
  assert.equal(ads.view().home.kind, 'ad');
  assert.equal(ads.view().home.image, true);
  assert.equal(ads.view().panel, null);
  assert.equal(s.changes.length, 1);

  // 失败：保留
  state.fail = true;
  assert.equal(await ads.refresh({ force: true }), 'fail');
  assert.equal(ads.view().home.title, '某应用');
  // 重启后从缓存恢复
  assert.equal(s.make().view().home.title, '某应用');
  // 失败太久就不再显示
  s.clock.t += MAX_STALE + 1;
  assert.equal(ads.view().home, null);
  s.clock.t -= MAX_STALE + 1;

  // JSON 坏了也算失败
  state.fail = false;
  state.files['index.html'] = page('{坏');
  assert.equal(await ads.refresh({ force: true }), 'fail');
  assert.ok(ads.view().home);

  // 明确没有广告：首页里没有节点
  state.files['index.html'] = '<html></html>';
  assert.equal(await ads.refresh({ force: true }), 'none');
  assert.deepEqual(ads.view(), { home: null, panel: null });
  assert.equal(JSON.parse(readFileSync(join(s.dir, 'ads.json'), 'utf8')).data, null);
  s.cleanup();
});

test('没有广告时显示招租文字；广告过期后也显示招租', async () => {
  const state = { files: { 'index.html': page({ version: 1, slots: { home: { ...AD, until: '2026-10-10' } }, placeholder: { title: '广告位招租', desc: '', link: 'tape://1-1196/' } }) } };
  const s = setup(state, new Date(2026, 9, 10, 12).getTime());
  const ads = s.make();
  await ads.refresh();
  assert.equal(ads.view().home.kind, 'ad');
  assert.deepEqual(ads.view().panel, { kind: 'placeholder', title: '广告位招租', desc: '', link: 'tape://1-1196/' });
  s.clock.t = new Date(2026, 9, 11, 1).getTime();
  assert.equal(ads.view().home.kind, 'placeholder');
  s.cleanup();
});

test('刷新节流、容器地址变了不信任、图片读取', async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const state = { files: { 'index.html': page({ version: 1, slots: { home: AD } }), 'ads/home.png': png } };
  const s = setup(state);
  const ads = s.make();
  await ads.refresh();
  assert.equal(await ads.refresh(), null, '5 分钟内不重读');
  s.clock.t += REFRESH_ON_VIEW + 1;
  assert.equal(await ads.refresh(), 'ok');
  assert.deepEqual(await ads.image('home'), { bytes: png, type: 'image/png' });
  assert.equal(await ads.image('panel'), null);
  assert.equal(await ads.image('__proto__'), null);

  state.container = '0x0000000000000000000000000000000000000001';
  assert.equal(await ads.refresh({ force: true }), 'fail');
  assert.equal(await ads.image('home'), null);
  assert.ok(ads.view().home, '旧广告保留');
  s.cleanup();
});
