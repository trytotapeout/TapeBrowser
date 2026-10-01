// 历史记录与书签：userData/library.json。不依赖 Electron（路径由调用方传入）。
//   history    打开过的电路网站，每个网站一条（按 origin 去重），最近访问的在前
//   bookmarks  书签，任意 http/https/tape 网址，最近添加的在前
// 标题更新很频繁，写盘做了合并（SAVE_DELAY），退出前调用 flush()。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseHost, siteHost, siteLabel } from './address.js';

const MAX_HISTORY = 200;
const MAX_BOOKMARKS = 500;
const MAX_URL = 2048;
const SAVE_DELAY = 1000;
const BOOKMARKABLE = /^(https?|tape):\/\//i;

const text = (s, n = 200) => String(s ?? '').trim().slice(0, n);

/** tape:// 网址 → {origin, label}；不是电路网站返回 null */
export function tapeSite(url) {
  const m = /^tape:\/\/([^/?#]+)/i.exec(String(url || ''));
  const s = m && parseHost(m[1]);
  return s ? { origin: `tape://${siteHost(s.tokenId, s.cpu)}`, label: siteLabel(s.tokenId, s.cpu) } : null;
}

export function createLibrary(file, { onChange = () => {}, now = Date.now } = {}) {
  let data = {};
  try { data = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
  const valid = (e) => e && typeof e.url === 'string' && BOOKMARKABLE.test(e.url);
  let history = Array.isArray(data.history) ? data.history.filter(valid) : [];
  let bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks.filter(valid) : [];
  let timer = null;

  function save() {
    clearTimeout(timer);
    timer = null;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ history, bookmarks }, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }

  function changed() {
    if (!timer) {
      timer = setTimeout(save, SAVE_DELAY);
      timer.unref?.();
    }
    onChange();
  }

  const entryOf = (url) => {
    const site = tapeSite(url);
    return site ? history.find((e) => e.url === site.origin + '/') : null;
  };

  return {
    history: () => history.map((e) => ({ ...e })),
    bookmarks: () => bookmarks.map((b) => ({ ...b })),

    /** 成功打开了一个电路网站页面；不是电路网站的网址不记录 */
    visit(url) {
      const site = tapeSite(url);
      if (!site) return;
      const key = site.origin + '/';
      const i = history.findIndex((e) => e.url === key);
      const entry = i >= 0 ? history.splice(i, 1)[0] : { url: key, label: site.label, title: '', visits: 0 };
      entry.visits += 1;
      entry.at = now();
      history.unshift(entry);
      if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
      changed();
    },

    /** 页面标题更新 */
    title(url, title) {
      const e = entryOf(url);
      const t = text(title);
      if (!e || !t || t === url || e.title === t) return;
      e.title = t;
      changed();
    },

    removeHistory(url) {
      const n = history.length;
      history = history.filter((e) => e.url !== url);
      if (history.length !== n) changed();
    },

    clearHistory() {
      if (!history.length) return;
      history = [];
      changed();
    },

    isBookmarked: (url) => bookmarks.some((b) => b.url === url),

    /** 添加或移除书签；返回添加后是否为书签状态 */
    toggleBookmark(url, title) {
      url = String(url || '');
      if (!BOOKMARKABLE.test(url) || url.length > MAX_URL) return false;
      const i = bookmarks.findIndex((b) => b.url === url);
      if (i >= 0) {
        bookmarks.splice(i, 1);
        changed();
        return false;
      }
      const site = tapeSite(url);
      bookmarks.unshift({ url, title: text(title) || site?.label || url, label: site?.label || null, at: now() });
      if (bookmarks.length > MAX_BOOKMARKS) bookmarks.length = MAX_BOOKMARKS;
      changed();
      return true;
    },

    removeBookmark(url) {
      const n = bookmarks.length;
      bookmarks = bookmarks.filter((b) => b.url !== url);
      if (bookmarks.length !== n) changed();
    },

    /** 立即写盘（退出前调用） */
    flush() { if (timer) save(); },
  };
}
