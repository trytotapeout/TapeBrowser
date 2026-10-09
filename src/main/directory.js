// 网站目录：链上所有「容器已开通、有 index.html」的电路，存在 userData/directory.json。不依赖 Electron。
//
// 每条链（BNB、X Layer、Base）独立扫描、并行进行，各自记录上次扫描时间；一条链的节点出问题不影响其他链。
//
// 完整扫描（第一次启动、之后每周一次，BNB 约三分钟，X Layer、Base 几秒；也可以手动「立即刷新」）
//   1. 每个处理器的 nextId → 全部已铸造编号
//   2. 所有编号的 isOpened（跨处理器打包，每批 400 个，批间限速）
//   3. 已开通的：持有人 + 容器，再查 index.html 的文件信息
//   扫完记下每个处理器扫到的编号（seen），以及容器已开通、还没有首页的电路（watch）
// 增量检查（每小时，几秒）
//   1. 每个处理器的 nextId，比 seen 大的就是上次之后新铸造的，加进 watch
//   2. watch 里的电路查是否开通、有没有首页，有了就收录
//   3. 已收录的网站重查持有人、容器、首页，发现首页更新、网站下线（删掉首页的放回 watch）
//   新铸造但一直没开通的电路留在 watch 里每小时查，直到下一次完整扫描；早就铸造、很久以后才开通容器的，
//   要等下一次完整扫描（最多一周）才会收录
// 标题：下载 index.html 取 <title>，按首页 sha256 缓存，内容没变不重新下载
// 图片：查首页时顺带查容器根目录的 logo.png / logo.jpg（正方形图标）和 cover.png / cover.jpg（16:10 封面），
//   只记文件信息，不下载；超过 50 KB 的不用。界面显示卡片时才按需读取（imageFor）
// 分类：站长在 deweb.json 里写了 category 就用它；没写时取首页标题时顺带推测一个（category.js），
//   按首页 sha256 缓存
//
// 标题来自网站自己的 HTML，界面只按纯文本显示。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { siteLabel, siteUrl, siteHost } from './address.js';
import { NETWORKS } from './config.js';
import { classify, declaredCategory } from './category.js';

export const FULL_SCAN_EVERY = 7 * 24 * 60 * 60 * 1000;
export const QUICK_CHECK_EVERY = 60 * 60 * 1000;
const TITLE_MAX_BYTES = 256 * 1024;
const TITLE_CONCURRENCY = 2;
const BATCH_PAUSE = 150;
// 站长放在网站根目录的卡片图片，按顺序取第一个存在的
export const IMAGE_FILES = { logo: ['logo.png', 'logo.jpg'], cover: ['cover.png', 'cover.jpg'] };
export const IMAGE_MAX_BYTES = 50 * 1024;
const IMAGE_PATHS = [...IMAGE_FILES.logo, ...IMAGE_FILES.cover];
// 站长对 DeWEB 应用的声明（目前只有 category），放在网站根目录，和 index.html 同一层
export const MANIFEST_PATH = 'deweb.json';
const MANIFEST_MAX_BYTES = 16 * 1024;

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

export function createDirectory({ chains, chain, sites, file, onChange = () => {}, onProgress = () => {}, now = Date.now, pause = BATCH_PAUSE }) {
  // 兼容只传一个 chain（BNB）
  if (!chains) chains = { bnb: chain };
  const nets = NETWORKS.filter((n) => chains[n.key]);
  // scans: { 网络 key: {lastFullScan, lastQuickCheck} }
  let data = { version: 2, sites: {}, scans: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    // 第 1 版只有 BNB，而且漏扫了每个处理器的最后一枚电路：沿用条目，但重新完整扫描
    if (raw && typeof raw.sites === 'object') data.sites = raw.version === 2 ? raw.sites : Object.fromEntries(Object.values(raw.sites).map((s) => [siteHost(s.tokenId, s.cpu, null), { ...s, area: null }]));
    if (raw?.version === 2 && raw.scans && typeof raw.scans === 'object') data.scans = raw.scans;
  } catch { /* 首次使用 */ }
  const scanOf = (net) => (data.scans[net.key] ??= { lastFullScan: 0, lastQuickCheck: 0 });
  const areaKey = (a) => (a === null || a === undefined ? null : Number(a));
  const ofNet = (net) => Object.entries(data.sites).filter(([, s]) => areaKey(s.area) === net.area);
  let running = null;
  // 每条链的进度：{ key: {stage, done, total} | {stage:'error', message} }
  const progress = {};

  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  function save() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(data));
    renameSync(file + '.tmp', file);
  }

  function report(net, p) {
    if (p) progress[net.key] = p; else delete progress[net.key];
    onProgress();
  }

  /** 查持有人、容器和首页：found 是 key → 收录条目（不符合条件的为 null）；waiting 是容器已开通但还没有首页的 */
  async function inspect(net, items, block) {
    const chain = chains[net.key];
    const infos = await chain.circuitInfos(items, block);
    const live = [];
    infos.forEach((info, i) => {
      if (info.exists && info.opened && info.container) live.push({ ...items[i], owner: info.owner, container: info.container });
    });
    // 每个网站查 index.html 和几张卡片图片，放在同一批 multicall 里
    const paths = ['index.html', ...IMAGE_PATHS, MANIFEST_PATH];
    const all = live.length ? await chain.fileInfos(live.flatMap((s) => paths.map((path) => ({ container: s.container, path }))), block) : [];
    const files = live.map((_, i) => all[i * paths.length]);
    const imagesOf = (i) => {
      const got = Object.fromEntries(IMAGE_PATHS.map((path, j) => [path, all[i * paths.length + 1 + j]]));
      const out = {};
      for (const [kind, names] of Object.entries(IMAGE_FILES)) {
        const path = names.find((n) => got[n]);
        const f = path && got[path];
        // 超过 50 KB 的直接不用，不往下找下一个格式：站长应该把图片压小，而不是被另一张旧图顶上
        if (f && f.size > 0 && f.size <= IMAGE_MAX_BYTES) out[kind] = { path, sha256: f.sha256, size: f.size };
      }
      return out;
    };
    const out = new Map(items.map((s) => [siteHost(s.tokenId, s.cpu, net.area), null]));
    const waiting = [];
    live.forEach((s, i) => {
      const f = files[i];
      if (!f) { waiting.push(s); return; }
      const key = siteHost(s.tokenId, s.cpu, net.area);
      const prev = data.sites[key];
      const img = imagesOf(i);
      const man = all[i * paths.length + paths.length - 1];
      const manifest = man && man.size > 0 && man.size <= MANIFEST_MAX_BYTES ? { sha256: man.sha256, size: man.size } : null;
      // 声明文件没变就沿用上次读到的分类
      const sameManifest = manifest && prev?.manifest?.sha256 === manifest.sha256;
      out.set(key, {
        tokenId: s.tokenId, cpu: s.cpu, area: net.area, network: net.key,
        label: siteLabel(s.tokenId, s.cpu, net.area), url: siteUrl(s.tokenId, s.cpu, '', net.area),
        circuits: s.circuits, owner: s.owner, container: s.container,
        sha256: f.sha256, size: f.size, updatedAt: f.updatedAt,
        logo: img.logo ?? null, cover: img.cover ?? null,
        manifest, declared: sameManifest ? prev.declared ?? null : null, manifestRead: sameManifest ? prev.manifestRead ?? null : null,
        guess: prev && prev.guessSha === f.sha256 ? prev.guess : null,
        guessSha: prev && prev.guessSha === f.sha256 ? prev.guessSha : null,
        // 首页没变就沿用已取到的标题
        title: prev && prev.titleSha === f.sha256 ? prev.title : '',
        titleSha: prev && prev.titleSha === f.sha256 ? prev.titleSha : null,
        firstSeen: prev?.firstSeen ?? now(),
        // 首页最早的上链时间（秒）：第一次收录时就是首页当时的上链时间，之后首页更新也不变。
        // 「新上线」按它排序，不用本机第一次扫到的时间（新装的浏览器会把所有网站都当成新的）
        firstPublished: prev?.firstPublished ?? earliest(prev?.updatedAt, f.updatedAt),
      });
    });
    return { found: out, waiting };
  }

  // 两个上链时间里较早的（秒），都没有时为 null
  const earliest = (...ts) => { const v = ts.filter((x) => Number.isFinite(x) && x > 0); return v.length ? Math.min(...v) : null; };

  const pick = (s) => ({ tokenId: s.tokenId, cpu: s.cpu, circuits: s.circuits });

  /** 每批 100 个电路 inspect，批间限速，汇总结果 */
  async function inspectAll(net, items, block, stage) {
    const found = new Map();
    const waiting = [];
    if (items.length) report(net, { stage, done: 0, total: items.length });
    for (let i = 0; i < items.length; i += 100) {
      const r = await inspect(net, items.slice(i, i + 100), block);
      for (const [k, v] of r.found) found.set(k, v);
      waiting.push(...r.waiting);
      report(net, { stage, done: Math.min(i + 100, items.length), total: items.length });
      await sleep(pause);
    }
    return { found, waiting };
  }

  function apply(results) {
    let changed = false;
    for (const [key, entry] of results) {
      if (entry) {
        const prev = data.sites[key];
        if (!prev || prev.sha256 !== entry.sha256 || prev.owner !== entry.owner || prev.container !== entry.container
          || prev.logo?.sha256 !== entry.logo?.sha256 || prev.cover?.sha256 !== entry.cover?.sha256
          || prev.manifest?.sha256 !== entry.manifest?.sha256) changed = true;
        data.sites[key] = entry;
      } else if (data.sites[key]) {
        delete data.sites[key];
        changed = true;
      }
    }
    return changed;
  }

  async function fullScan(net) {
    const chain = chains[net.key];
    report(net, { stage: 'cpus' });
    // 扫描要几分钟，公共节点会裁剪旧区块状态（missing trie node），目录不需要一致快照，直接读最新块
    const block = 'latest';
    const cpus = await chain.cpuList(block);
    const ids = await chain.nextIds(cpus, block);
    const pairs = [];
    ids.forEach((n, cpu) => {
      // nextId 是最后一个已铸造的编号（含），不是下一个待铸造的
      for (let tokenId = 1; tokenId <= n; tokenId++) pairs.push({ circuits: cpus[cpu], tokenId, cpu });
    });
    report(net, { stage: 'opened', done: 0, total: pairs.length });
    const flags = await chain.openedFlags(pairs, block, async (done, total) => {
      report(net, { stage: 'opened', done, total });
      await sleep(pause);
    });
    const opened = pairs.filter((_, i) => flags[i]);
    const { found, waiting } = await inspectAll(net, opened, block, 'index');
    // 这条链上这次没扫到的旧条目（容器关闭、电路销毁）一并移除
    for (const [key] of ofNet(net)) if (!found.has(key)) found.set(key, null);
    apply(found);
    const sc = scanOf(net);
    sc.seen = Object.fromEntries(cpus.map((c, i) => [c, ids[i]]).filter(([c]) => c));
    sc.watch = Object.fromEntries(waiting.map((x) => [siteHost(x.tokenId, x.cpu, net.area), pick(x)]));
    sc.lastFullScan = now();
    sc.lastQuickCheck = now();
    save();
    onChange();
  }

  async function incremental(net) {
    const chain = chains[net.key];
    const sc = scanOf(net);
    const block = 'latest';
    report(net, { stage: 'cpus' });
    const cpus = await chain.cpuList(block);
    const ids = await chain.nextIds(cpus, block);
    const seen = { ...sc.seen };
    const watch = { ...sc.watch };
    // 上次之后新铸造的编号（新处理器从 1 开始）
    ids.forEach((n, cpu) => {
      const c = cpus[cpu];
      if (!c) return;
      for (let tokenId = (seen[c] || 0) + 1; tokenId <= n; tokenId++) watch[siteHost(tokenId, cpu, net.area)] = { tokenId, cpu, circuits: c };
      if (n > (seen[c] || 0)) seen[c] = n;
    });
    // watch 里的：先查是否开通，开通的再查首页
    const pend = Object.values(watch);
    if (pend.length) report(net, { stage: 'opened', done: 0, total: pend.length });
    const flags = pend.length ? await chain.openedFlags(pend, block, async (done, total) => {
      report(net, { stage: 'opened', done, total });
      await sleep(pause);
    }) : [];
    const fresh = await inspectAll(net, pend.filter((_, i) => flags[i]), block, 'index');
    // 已收录的：首页更新、网站下线
    const known = await inspectAll(net, ofNet(net).map(([, x]) => x), block, 'check');
    // watch 里的 key 不在目录里，known 的结果放后面，同一个 key 以已收录网站的检查结果为准
    const found = new Map([...fresh.found, ...known.found]);
    for (const [k, v] of found) if (v) delete watch[k];
    for (const x of known.waiting) watch[siteHost(x.tokenId, x.cpu, net.area)] = pick(x);
    const changed = apply(found);
    sc.seen = seen;
    sc.watch = watch;
    sc.lastQuickCheck = now();
    save();
    if (changed) onChange();
  }

  /** 下载还没有标题（或首页已更新）的网站首页，取 <title> */
  async function fetchTitles(net) {
    const todo = ofNet(net).map(([, s]) => s).filter((s) => (s.titleSha !== s.sha256 || s.guessSha !== s.sha256) && s.size <= TITLE_MAX_BYTES);
    if (!todo.length) return;
    let next = 0;
    let done = 0;
    let dirty = 0;
    report(net, { stage: 'titles', done: 0, total: todo.length });
    async function worker() {
      while (next < todo.length) {
        const s = todo[next++];
        try {
          // 走 sites.readFile：校验 sha256，并顺带存进内容缓存
          const f = await sites.readFile(s.container, 'index.html', net.area);
          const cur = data.sites[siteHost(s.tokenId, s.cpu, net.area)];
          if (f && cur) {
            cur.title = extractTitle(f.bytes);
            cur.titleSha = f.info.sha256;
            cur.guess = classify(cur.title, f.bytes);
            cur.guessSha = f.info.sha256;
            dirty++;
          }
        } catch { /* 取不到标题就先留空，下次再试 */ }
        done++;
        report(net, { stage: 'titles', done, total: todo.length });
        if (dirty >= 20) { dirty = 0; save(); onChange(); }
        await sleep(pause);
      }
    }
    await Promise.all(Array.from({ length: TITLE_CONCURRENCY }, worker));
    save();
    onChange();
  }

  /** 读取有变化的 deweb.json，取站长声明的分类 */
  async function fetchManifests(net) {
    const todo = ofNet(net).map(([, s]) => s).filter((s) => s.manifest && s.manifestRead !== s.manifest.sha256);
    if (!todo.length) return;
    for (const s of todo) {
      let declared = null;
      try {
        const f = await sites.readFile(s.container, MANIFEST_PATH, net.area);
        if (f && f.bytes.length <= MANIFEST_MAX_BYTES) declared = declaredCategory(JSON.parse(new TextDecoder().decode(f.bytes)));
      } catch { /* 不是合法 JSON 就当没声明 */ }
      const cur = data.sites[siteHost(s.tokenId, s.cpu, net.area)];
      if (cur) { cur.declared = declared; cur.manifestRead = s.manifest.sha256; }
      await sleep(pause);
    }
    save();
    onChange();
  }

  /** 列表里给界面的分类：站长声明的优先，其次是按首页推测的，首页太大没下载的只按标题推测 */
  function categoryOf(s) {
    if (s.declared) return { category: s.declared, categoryFrom: 'declared', categoryWhy: [] };
    const g = s.guess && s.guessSha === s.sha256 ? s.guess : classify(s.title, null);
    return { category: g.category, categoryFrom: 'guess', categoryWhy: g.why };
  }

  async function refreshNet(net, force) {
    try {
      const t = now();
      const sc = scanOf(net);
      // 没有 seen（第一次、或旧版目录文件）只能完整扫描
      if (force || !sc.lastFullScan || !sc.seen || t - sc.lastFullScan >= FULL_SCAN_EVERY) await fullScan(net);
      else if (t - sc.lastQuickCheck >= QUICK_CHECK_EVERY) await incremental(net);
      await fetchTitles(net);
      await fetchManifests(net);
      delete progress[net.key];
    } catch (e) {
      progress[net.key] = { stage: 'error', message: String(e?.message || e) };
      throw e;
    }
  }

  /** 按需执行：到期才扫；force=true 立即完整扫描。各链并行；同一时间只跑一轮。全部链都失败时 reject */
  function refresh({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
      try {
        const settled = await Promise.allSettled(nets.map((net) => refreshNet(net, force)));
        const failed = settled.filter((r) => r.status === 'rejected');
        if (failed.length === settled.length && failed.length) throw failed[0].reason;
      } finally {
        // 先清掉 running 再推送，界面才会重新显示「立即刷新」
        running = null;
        onProgress();
      }
    })();
    return running;
  }

  function status() {
    const counts = {};
    for (const s of Object.values(data.sites)) counts[s.network || 'bnb'] = (counts[s.network || 'bnb'] || 0) + 1;
    const scanned = nets.map((n) => scanOf(n).lastFullScan).filter(Boolean);
    const checked = nets.map((n) => scanOf(n).lastQuickCheck).filter(Boolean);
    const all = scanned.length === nets.length;
    return {
      count: Object.keys(data.sites).length,
      // 最早完成的那条链的时间：所有链都扫过才算「更新于」
      lastFullScan: all ? Math.min(...scanned) : 0,
      // 最近一次检查（完整扫描或增量检查）
      lastUpdate: all && checked.length === nets.length ? Math.min(...checked) : 0,
      running: Boolean(running),
      networks: nets.map((n) => ({ key: n.key, name: n.name, count: counts[n.key] || 0, lastFullScan: scanOf(n).lastFullScan, progress: progress[n.key] ?? null })),
    };
  }

  /**
   * 读取某个网站的卡片图片（kind 是 logo / cover），返回 {bytes, type} 或 null。
   * 只读目录里记下的那个文件，sha256 对不上（图片刚更新、目录还没检查到）就不显示
   */
  async function imageFor(host, kind) {
    const s = data.sites[host];
    const img = s && IMAGE_FILES[kind] && s[kind];
    if (!img) return null;
    const f = await sites.readFile(s.container, img.path, areaKey(s.area));
    if (!f || f.info.sha256 !== img.sha256 || f.bytes.length > IMAGE_MAX_BYTES) return null;
    return { bytes: f.bytes, type: img.path.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }

  return {
    refresh,
    imageFor,
    list: () => Object.values(data.sites).map((s) => ({ network: 'bnb', area: null, ...s, ...categoryOf(s) })),
    status,
  };
}
