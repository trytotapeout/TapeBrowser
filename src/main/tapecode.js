// TapeCode 分享的应用：开发者在 TapeCode 内置的 TapeTape 里分享过的网站。不依赖 Electron（fetch 由调用方传入）。
//
// 数据来自 TapeCode 的公开接口 FEED_API（不用登录），按 bumped 往前翻页：
//   { posts: [{ id, title, app: '1413.30.tape', author: { addr, circuit, verified }, at, bumped, ... }], more }
// 只说明「有人在 TapeTape 里分享过这个网站」，不能证明网站是用 TapeCode 做的，界面上标「Shared by TapeCode」。
// 这是中心化接口：读不到时一直用上次的结果，不影响其他功能。
//
// 缓存（userData/tapecode.json）：{ apps: { 主机名: { post, title, at } }, readAt }

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseHost, siteHost } from './address.js';

export const FEED_API = 'https://tapecode.ai/api/tape/feed?kind=apps';
export const REFRESH_EVERY = 60 * 60 * 1000;
// 翻页上限，防止接口出错时一直翻
const MAX_PAGES = 50;
const TITLE_MAX = 80;

/** 一页接口返回 → { apps: [{ host, post, title, at }], more, cursor }；格式不对抛错 */
export function parseFeed(body) {
  if (!body || !Array.isArray(body.posts)) throw new Error('bad feed');
  const apps = [];
  let cursor = null;
  for (const p of body.posts) {
    if (typeof p?.bumped === 'number') cursor = cursor === null ? p.bumped : Math.min(cursor, p.bumped);
    const s = typeof p?.app === 'string' ? parseHost(p.app.trim()) : null;
    if (!s || !Number.isSafeInteger(p.id)) continue;
    const title = typeof p.title === 'string' ? p.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, TITLE_MAX) : '';
    apps.push({ host: siteHost(s.tokenId, s.cpu, s.area), post: p.id, title, at: typeof p.at === 'number' ? p.at : 0 });
  }
  return { apps, more: body.more === true, cursor };
}

/** onChange()：分享列表变了（包括第一次读到） */
export function createTapeCode({ file, fetchImpl, onChange = () => {}, now = () => Date.now(), timeout = 15000 }) {
  let cache = { apps: {}, readAt: 0 };
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (c && typeof c.apps === 'object' && typeof c.readAt === 'number') cache = { apps: c.apps, readAt: c.readAt };
  } catch { /* 没有缓存 */ }
  let inflight = null;

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(cache));
      renameSync(file + '.tmp', file);
    } catch { /* 缓存写不进去不影响使用 */ }
  }

  async function page(before) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetchImpl(FEED_API + (before ? `&before=${before}` : ''), { headers: { accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return parseFeed(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  /** 读完所有页才替换缓存（中途失败保留上次的结果，免得少了一半）；同一网站分享多次取最早那条 */
  async function load() {
    const apps = {};
    let before = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await page(before);
      for (const a of r.apps) if (!apps[a.host] || a.at < apps[a.host].at) apps[a.host] = { post: a.post, title: a.title, at: a.at };
      if (!r.more || r.cursor === null || r.cursor === before) break;
      before = r.cursor;
    }
    const changed = JSON.stringify(apps) !== JSON.stringify(cache.apps);
    cache = { apps, readAt: now() };
    save();
    if (changed) onChange();
  }

  /** 后台刷新；force=false 时距上次成功读取不到 REFRESH_EVERY 就不读 */
  function refresh({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && cache.readAt && now() - cache.readAt < REFRESH_EVERY) return Promise.resolve();
    inflight = load()
      .catch((e) => console.error('tapecode feed:', e?.name === 'AbortError' ? 'timeout' : e?.message || e))
      .finally(() => { inflight = null; });
    return inflight;
  }

  /** 网站在 TapeTape 里的分享：{ post, title, at } | null */
  const shared = (tokenId, cpu, area = null) => cache.apps[siteHost(tokenId, cpu, area)] || null;

  return { refresh, shared };
}
