import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSection, createRemoteConfig, CONFIG_CONTAINER, REFRESH_ON_VIEW } from '../src/main/remote-config.js';

const node = (id, obj) => `<script type="application/json" id="${id}">${typeof obj === 'string' ? obj : JSON.stringify(obj)}</script>`;
const page = (...nodes) => `<!doctype html><html><head>${nodes.join('\n')}</head><body><div data-slot="home"></div></body></html>`;

test('extractSection：ok / none / bad', () => {
  const html = page(node('tape-ads', { version: 1, a: 1 }), node('tape-block', '{坏'), node('tape-x', { version: 2 }));
  assert.deepEqual(extractSection(html, 'tape-ads'), { status: 'ok', raw: { version: 1, a: 1 } });
  assert.equal(extractSection(html, 'tape-block').status, 'bad');
  assert.equal(extractSection(html, 'tape-x').status, 'bad');
  assert.equal(extractSection(html, 'tape-none').status, 'none');
  assert.equal(extractSection(html, 'tape-ad').status, 'none', 'id 要完全一致');
});

function fakeSites(state) {
  return {
    site: async () => { if (state.fail) throw new Error('rpc down'); return { exists: true, opened: true, container: state.container ?? CONFIG_CONTAINER }; },
    readFile: async (_c, path) => {
      if (state.fail) throw new Error('rpc down');
      const v = state.files[path];
      return v === undefined ? null : { bytes: new TextEncoder().encode(v), info: {}, source: 'chain' };
    },
  };
}

const SECTIONS = { ads: { id: 'tape-ads', parse: (r) => r.v ?? null }, block: { id: 'tape-block', parse: (r) => r.v ?? null } };

test('每段各自生效：坏一段不影响另一段；读取失败全部保留；没有节点立即清空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const clock = { t: 1_800_000_000_000 };
  const state = { files: { 'index.html': page(node('tape-ads', { version: 1, v: 'ad1' }), node('tape-block', { version: 1, v: 'b1' })) } };
  let changes = 0;
  const make = () => createRemoteConfig({ sites: fakeSites(state), file: join(dir, 'c.json'), sections: SECTIONS, now: () => clock.t, onChange: () => changes++ });
  const rc = make();
  assert.equal(rc.section('ads'), null);
  assert.deepEqual(await rc.refresh(), { ads: 'ok', block: 'ok' });
  assert.equal(rc.section('ads').data, 'ad1');
  assert.equal(changes, 1);
  // 内容没变不通知
  await rc.refresh({ force: true });
  assert.equal(changes, 1);

  // 广告段坏了：广告保留，屏蔽照常更新
  state.files['index.html'] = page(node('tape-ads', '{坏'), node('tape-block', { version: 1, v: 'b2' }));
  assert.deepEqual(await rc.refresh({ force: true }), { ads: 'bad', block: 'ok' });
  assert.equal(rc.section('ads').data, 'ad1');
  assert.equal(rc.section('block').data, 'b2');

  // 读链失败：全部保留；重启后从缓存恢复
  state.fail = true;
  assert.deepEqual(await rc.refresh({ force: true }), { ads: 'fail', block: 'fail' });
  assert.equal(rc.section('block').data, 'b2');
  assert.equal(make().section('ads').data, 'ad1');

  // 容器地址变了：不信任
  state.fail = false;
  state.container = '0x0000000000000000000000000000000000000001';
  assert.deepEqual(await rc.refresh({ force: true }), { ads: 'fail', block: 'fail' });
  delete state.container;

  // 首页里没有广告节点：广告立即清空，屏蔽保留
  state.files['index.html'] = page(node('tape-block', { version: 1, v: 'b2' }));
  assert.deepEqual(await rc.refresh({ force: true }), { ads: 'none', block: 'ok' });
  assert.equal(rc.section('ads').data, null);
  // 没有首页：全部明确为空
  delete state.files['index.html'];
  assert.deepEqual(await rc.refresh({ force: true }), { ads: 'none', block: 'none' });
  assert.equal(rc.section('block').data, null);
  rmSync(dir, { recursive: true, force: true });
});

test('刷新节流', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const clock = { t: 1_800_000_000_000 };
  const state = { files: { 'index.html': page() } };
  const rc = createRemoteConfig({ sites: fakeSites(state), file: join(dir, 'c.json'), sections: SECTIONS, now: () => clock.t });
  assert.ok(await rc.refresh());
  assert.equal(await rc.refresh(), null, '5 分钟内不重读');
  clock.t += REFRESH_ON_VIEW + 1;
  assert.ok(await rc.refresh());
  rmSync(dir, { recursive: true, force: true });
});
