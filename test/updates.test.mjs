import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, checkLatest, autoCheck, RELEASES_API, CHECK_EVERY } from '../src/main/updates.js';

const reply = (body, status = 200) => async (url) => {
  assert.equal(url, RELEASES_API);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
const memSettings = (init = {}) => { const d = { ...init }; return { get: (k) => d[k], set: (k, v) => { d[k] = v; }, d }; };

test('parseVersion / compareVersions', () => {
  assert.deepEqual(parseVersion('v0.14.0'), [0, 14, 0]);
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  for (const bad of ['', null, 'v1.2', '1.2.3-beta.1', 'latest']) assert.equal(parseVersion(bad), null);
  assert.ok(compareVersions([0, 15, 0], [0, 14, 9]) > 0);
  assert.ok(compareVersions([0, 9, 0], [0, 10, 0]) < 0);
  assert.equal(compareVersions([1, 0, 0], [1, 0, 0]), 0);
});

test('checkLatest：新版本、已是最新、出错', async () => {
  assert.deepEqual(await checkLatest({ current: '0.14.0', fetchImpl: reply({ tag_name: 'v0.15.0', html_url: 'https://evil.example' }) }),
    { status: 'new', version: '0.15.0', url: 'https://github.com/trytotapeout/TapeBrowser/releases/tag/v0.15.0' });
  assert.equal((await checkLatest({ current: '0.14.0', fetchImpl: reply({ tag_name: 'v0.14.0' }) })).status, 'latest');
  assert.equal((await checkLatest({ current: '0.14.0', fetchImpl: reply({ tag_name: 'v0.13.0' }) })).status, 'latest');
  assert.equal((await checkLatest({ current: '0.14.0', fetchImpl: reply({ tag_name: 'v0.15.0', prerelease: true }) })).status, 'error');
  assert.equal((await checkLatest({ current: '0.14.0', fetchImpl: reply({}, 403) })).message, 'HTTP 403');
  assert.equal((await checkLatest({ current: '0.14.0', fetchImpl: async () => { throw new Error('offline'); } })).message, 'offline');
});

test('checkLatest：超时', async () => {
  const hang = (_u, { signal }) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  assert.deepEqual(await checkLatest({ current: '0.14.0', fetchImpl: hang, timeout: 10 }), { status: 'error', message: 'timeout' });
});

test('autoCheck：一天一次，跳过的版本不提示，出错不记时间', async () => {
  const now = 1_800_000_000_000;
  const s = memSettings({ updateCheckedAt: now - 1000 });
  let calls = 0;
  const f = async (...a) => { calls++; return reply({ tag_name: 'v0.15.0' })(...a); };
  assert.equal((await autoCheck({ current: '0.14.0', fetchImpl: f, settings: s, now })).status, 'skipped');
  assert.equal(calls, 0);

  s.set('updateCheckedAt', now - CHECK_EVERY);
  assert.equal((await autoCheck({ current: '0.14.0', fetchImpl: f, settings: s, now })).status, 'new');
  assert.equal(s.d.updateCheckedAt, now);

  s.set('updateCheckedAt', 0); s.set('updateSkip', '0.15.0');
  assert.equal((await autoCheck({ current: '0.14.0', fetchImpl: f, settings: s, now })).status, 'latest');

  // 系统时间被往回调过：照样检查
  s.set('updateCheckedAt', now + 5000); s.set('updateSkip', null);
  assert.equal((await autoCheck({ current: '0.14.0', fetchImpl: f, settings: s, now })).status, 'new');

  const e = memSettings();
  assert.equal((await autoCheck({ current: '0.14.0', fetchImpl: reply({}, 500), settings: e, now })).status, 'error');
  assert.equal(e.d.updateCheckedAt, undefined);
});
