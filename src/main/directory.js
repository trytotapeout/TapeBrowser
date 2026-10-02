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
//
// 标题来自网站自己的 HTML，界面只按纯文本显示。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { siteLabel, siteUrl, siteHost } from './address.js';
import { NETWORKS } from './config.js';

export const FULL_SCAN_EVERY = 7 * 24 * 60 * 60 * 1000;
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
    const files = live.length ? await chain.fileInfos(live.map((s) => ({ container: s.container, path: 'index.html' })), block) : [];
    const out = new Map(items.map((s) => [siteHost(s.tokenId, s.cpu, net.area), null]));
    const waiting = [];
    live.forEach((s, i) => {
      const f = files[i];
      if (!f) { waiting.push(s); return; }
      const key = siteHost(s.tokenId, s.cpu, net.area);
      const prev = data.sites[key];
      out.set(key, {
        tokenId: s.tokenId, cpu: s.cpu, area: net.area, network: net.key,
        label: siteLabel(s.tokenId, s.cpu, net.area), url: siteUrl(s.tokenId, s.cpu, '', net.area),
        circuits: s.circuits, owner: s.owner, container: s.container,
        sha256: f.sha256, size: f.size, updatedAt: f.updatedAt,
        // 首页没变就沿用已取到的标题
        title: prev && prev.titleSha === f.sha256 ? prev.title : '',
        titleSha: prev && prev.titleSha === f.sha256 ? prev.titleSha : null,
        firstSeen: prev?.firstSeen ?? now(),
      });
    });
    return { found: out, waiting };
  }

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
        if (!prev || prev.sha256 !== entry.sha256 || prev.owner !== entry.owner || prev.container !== entry.container) changed = true;
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
    const todo = ofNet(net).map(([, s]) => s).filter((s) => s.titleSha !== s.sha256 && s.size <= TITLE_MAX_BYTES);
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

  async function refreshNet(net, force) {
    try {
      const t = now();
      const sc = scanOf(net);
      // 没有 seen（第一次、或旧版目录文件）只能完整扫描
      if (force || !sc.lastFullScan || !sc.seen || t - sc.lastFullScan >= FULL_SCAN_EVERY) await fullScan(net);
      else if (t - sc.lastQuickCheck >= QUICK_CHECK_EVERY) await incremental(net);
      await fetchTitles(net);
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

  return {
    refresh,
    list: () => Object.values(data.sites).map((s) => ({ network: 'bnb', area: null, ...s })),
    status,
  };
}
