// 网站目录：链上所有「容器已开通、有 index.html」的电路，存在 userData/directory.json。不依赖 Electron。
//
// 完整扫描（每天一次，约两分钟）
//   1. 每个处理器的 nextId → 全部已铸造编号
//   2. 所有编号的 isOpened（跨处理器打包，每批 400 个，批间限速）
//   3. 已开通的：持有人 + 容器，再查 index.html 的文件信息
// 快速检查（每小时）：只对已收录网站重查持有人、容器、首页信息，发现首页更新、网站下线
// 标题：下载 index.html 取 <title>，按首页 sha256 缓存，内容没变不重新下载
//
// 标题来自网站自己的 HTML，界面只按纯文本显示。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { siteLabel, siteUrl } from './address.js';

export const FULL_SCAN_EVERY = 24 * 60 * 60 * 1000;
export const QUICK_CHECK_EVERY = 60 * 60 * 1000;
const TITLE_MAX_BYTES = 256 * 1024;
const TITLE_CONCURRENCY = 2;
const BATCH_PAUSE = 150;

/** 从 HTML 里取 <title> 的纯文本 */
export function extractTitle(bytes) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64 * 1024));
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!m) return '';
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return m[1]
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return named[e.toLowerCase()] ?? all;
    })
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function createDirectory({ chain, sites, file, onChange = () => {}, onProgress = () => {}, now = Date.now, pause = BATCH_PAUSE }) {
  let data = { sites: {}, lastFullScan: 0, lastQuickCheck: 0 };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw.sites === 'object') data = { ...data, ...raw };
  } catch { /* 首次使用 */ }
  let running = null;
  let progress = null;

  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  function save() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(data));
    renameSync(file + '.tmp', file);
  }

  function report(p) {
    progress = p;
    onProgress(p);
  }

  /** 查持有人、容器和首页，返回收录条目；不再符合条件的返回 null */
  async function inspect(items, block) {
    const infos = await chain.circuitInfos(items, block);
    const live = [];
    infos.forEach((info, i) => {
      if (info.exists && info.opened && info.container) live.push({ ...items[i], owner: info.owner, container: info.container });
    });
    const files = live.length ? await chain.fileInfos(live.map((s) => ({ container: s.container, path: 'index.html' })), block) : [];
    const out = new Map(items.map((s) => [`${s.tokenId}-${s.cpu}`, null]));
    live.forEach((s, i) => {
      const f = files[i];
      if (!f) return;
      const key = `${s.tokenId}-${s.cpu}`;
      const prev = data.sites[key];
      out.set(key, {
        tokenId: s.tokenId, cpu: s.cpu, label: siteLabel(s.tokenId, s.cpu), url: siteUrl(s.tokenId, s.cpu),
        circuits: s.circuits, owner: s.owner, container: s.container,
        sha256: f.sha256, size: f.size, updatedAt: f.updatedAt,
        // 首页没变就沿用已取到的标题
        title: prev && prev.titleSha === f.sha256 ? prev.title : '',
        titleSha: prev && prev.titleSha === f.sha256 ? prev.titleSha : null,
        firstSeen: prev?.firstSeen ?? now(),
      });
    });
    return out;
  }

  function apply(results) {
    let changed = false;
    for (const [key, entry] of results) {
      if (entry) {
        const prev = data.sites[key];
        if (!prev || prev.sha256 !== entry.sha256 || prev.owner !== entry.owner || prev.container !== entry.container) changed = true;
        data.sites[key] = entry;
      } else if (data.sites[key]) {
        delete data.sites[key];
        changed = true;
      }
    }
    return changed;
  }

  async function fullScan() {
    report({ stage: 'cpus' });
    // 扫描要几分钟，公共节点会裁剪旧区块状态（missing trie node），目录不需要一致快照，直接读最新块
    const block = 'latest';
    const cpus = await chain.cpuList(block);
    const ids = await chain.nextIds(cpus, block);
    const pairs = [];
    ids.forEach((n, cpu) => {
      // nextId 是最后一个已铸造的编号（含），不是下一个待铸造的
      for (let tokenId = 1; tokenId <= n; tokenId++) pairs.push({ circuits: cpus[cpu], tokenId, cpu });
    });
    report({ stage: 'opened', done: 0, total: pairs.length });
    const flags = await chain.openedFlags(pairs, block, async (done, total) => {
      report({ stage: 'opened', done, total });
      await sleep(pause);
    });
    const opened = pairs.filter((_, i) => flags[i]);
    report({ stage: 'index', done: 0, total: opened.length });
    const results = new Map();
    const step = 100;
    for (let i = 0; i < opened.length; i += step) {
      for (const [k, v] of await inspect(opened.slice(i, i + step), block)) results.set(k, v);
      report({ stage: 'index', done: Math.min(i + step, opened.length), total: opened.length });
      await sleep(pause);
    }
    // 这次没扫到的旧条目（容器关闭、电路销毁）一并移除
    for (const key of Object.keys(data.sites)) if (!results.has(key)) results.set(key, null);
    apply(results);
    data.lastFullScan = now();
    data.lastQuickCheck = now();
    save();
    onChange();
  }

  async function quickCheck() {
    const list = Object.values(data.sites);
    if (!list.length) return;
    report({ stage: 'check', done: 0, total: list.length });
    // 扫描要几分钟，公共节点会裁剪旧区块状态（missing trie node），目录不需要一致快照，直接读最新块
    const block = 'latest';
    const results = new Map();
    const step = 100;
    for (let i = 0; i < list.length; i += step) {
      for (const [k, v] of await inspect(list.slice(i, i + step), block)) results.set(k, v);
      report({ stage: 'check', done: Math.min(i + step, list.length), total: list.length });
      await sleep(pause);
    }
    const changed = apply(results);
    data.lastQuickCheck = now();
    save();
    if (changed) onChange();
  }

  /** 下载还没有标题（或首页已更新）的网站首页，取 <title> */
  async function fetchTitles() {
    const todo = Object.values(data.sites).filter((s) => s.titleSha !== s.sha256 && s.size <= TITLE_MAX_BYTES);
    if (!todo.length) return;
    let next = 0;
    let done = 0;
    let dirty = 0;
    report({ stage: 'titles', done: 0, total: todo.length });
    async function worker() {
      while (next < todo.length) {
        const s = todo[next++];
        try {
          // 走 sites.readFile：校验 sha256，并顺带存进内容缓存
          const f = await sites.readFile(s.container, 'index.html');
          const cur = data.sites[`${s.tokenId}-${s.cpu}`];
          if (f && cur) {
            cur.title = extractTitle(f.bytes);
            cur.titleSha = f.info.sha256;
            dirty++;
          }
        } catch { /* 取不到标题就先留空，下次再试 */ }
        done++;
        report({ stage: 'titles', done, total: todo.length });
        if (dirty >= 20) { dirty = 0; save(); onChange(); }
        await sleep(pause);
      }
    }
    await Promise.all(Array.from({ length: TITLE_CONCURRENCY }, worker));
    save();
    onChange();
  }

  /** 按需执行：到期才扫；force=true 立即完整扫描。同一时间只跑一个 */
  function refresh({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      try {
        const t = now();
        if (force || !data.lastFullScan || t - data.lastFullScan >= FULL_SCAN_EVERY) await fullScan();
        else if (t - data.lastQuickCheck >= QUICK_CHECK_EVERY) await quickCheck();
        await fetchTitles();
        progress = null;
      } catch (e) {
        progress = { stage: 'error', message: String(e?.message || e) };
        throw e;
      } finally {
        // 先清掉 running 再推送，界面才会重新显示「立即刷新」
        running = null;
        onProgress(progress);
      }
    })();
    return running;
  }

  return {
    refresh,
    list: () => Object.values(data.sites).map((s) => ({ ...s })),
    status: () => ({ count: Object.keys(data.sites).length, lastFullScan: data.lastFullScan, running: Boolean(running), progress }),
  };
}
