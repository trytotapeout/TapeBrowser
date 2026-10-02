// 历史记录与书签：userData/library.json。不依赖 Electron（路径由调用方传入）。
//   history    打开过的电路网站，每个网站一条（按 origin 去重），最近访问的在前
//   bookmarks  书签，任意 http/https/tape 网址，最近添加的在前
//   seen       每个电路网站上次看到的持有人和首页 sha256（按 origin），用来发现
//                updated       首页在上次访问之后更新了（目录每小时检查）
//                ownerChange   持有人变了 {from, to, at}：网站内容现在由新持有人控制
//              访问网站时重新记下当前的持有人和首页，清掉 updated；持有人变化在访问时提醒一次，
//              最近一次变更记在 prevOwner / ownerChangedAt
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
  return s ? { origin: `tape://${siteHost(s.tokenId, s.cpu, s.area)}`, label: siteLabel(s.tokenId, s.cpu, s.area) } : null;
}

export function createLibrary(file, { onChange = () => {}, now = Date.now } = {}) {
  let data = {};
  try { data = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
  const valid = (e) => e && typeof e.url === 'string' && BOOKMARKABLE.test(e.url);
  let history = Array.isArray(data.history) ? data.history.filter(valid) : [];
  let bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks.filter(valid) : [];
  const seen = data.seen && typeof data.seen === 'object' ? data.seen : {};
  let timer = null;

  function save() {
    clearTimeout(timer);
    timer = null;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ history, bookmarks, seen }, null, 2), { mode: 0o600 });
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

  const lc = (a) => (a ? String(a).toLowerCase() : null);
  /** 列表条目加上 updated / ownerChange 标记 */
  const flag = (e) => {
    const s = tapeSite(e.url);
    const w = s && seen[s.origin];
    return w ? { ...e, updated: Boolean(w.updated), ownerChange: w.ownerChange || null } : { ...e };
  };

  return {
    history: () => history.map(flag),
    bookmarks: () => bookmarks.map(flag),

    /**
     * 访问网站后读到的当前状态 {owner, sha256}。记为新的基准，清掉「有更新」；
     * 返回 {from, to}（持有人和上次看到的不一样）或 null
     */
    observe(url, info) {
      const site = tapeSite(url);
      if (!site || !info) return null;
      const w = seen[site.origin];
      const owner = lc(info.owner);
      const sha = lc(info.sha256);
      let change = null;
      if (w?.owner && owner && w.owner !== owner) change = { from: w.owner, to: owner };
      // 目录先发现了持有人变化（还没访问过），访问时同样提醒
      else if (w?.ownerChange && w.ownerChange.to === owner) change = { from: w.ownerChange.from, to: owner };
      const next = {
        owner: owner || w?.owner || null, sha256: sha, updated: false, ownerChange: null,
        // 最近一次持有人变更，网站信息面板一直显示
        prevOwner: change ? change.from : w?.prevOwner || null,
        ownerChangedAt: change ? w?.ownerChange?.at || now() : w?.ownerChangedAt || null,
      };
      if (!w || w.owner !== next.owner || w.sha256 !== next.sha256 || w.updated || w.ownerChange || change) {
        seen[site.origin] = next;
        changed();
      }
      return change;
    },

    /**
     * 目录更新后比对：sites = 目录条目 [{url, owner, sha256}]。
     * 记录过的网站首页变了标「有更新」，持有人变了标 ownerChange；还没有基准的历史和书签用目录补上基准
     */
    syncDirectory(sites) {
      const byOrigin = new Map();
      for (const d of sites) {
        const s = tapeSite(d.url);
        if (s) byOrigin.set(s.origin, d);
      }
      const origins = new Set([...history, ...bookmarks].map((e) => tapeSite(e.url)?.origin).filter(Boolean));
      let dirty = false;
      for (const origin of origins) {
        const d = byOrigin.get(origin);
        if (!d) continue;
        const owner = lc(d.owner);
        const sha = lc(d.sha256);
        const w = seen[origin];
        if (!w) { seen[origin] = { owner, sha256: sha, updated: false, ownerChange: null }; dirty = true; continue; }
        if (w.sha256 && sha && w.sha256 !== sha && !w.updated) { w.updated = true; dirty = true; }
        if (w.owner && owner && w.owner !== owner && w.ownerChange?.to !== owner) {
          w.ownerChange = { from: w.ownerChange?.from || w.owner, to: owner, at: now() };
          dirty = true;
        }
      }
      if (dirty) changed();
    },

    /** 网站上次看到的状态（网站信息面板用） */
    seenOf(url) {
      const s = tapeSite(url);
      return s && seen[s.origin] ? { ...seen[s.origin] } : null;
    },

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
