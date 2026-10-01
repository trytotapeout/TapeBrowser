// 电路网站的解析、读取、枚举与钱包扫描。不依赖 Electron。
//
// 缓存：
//   处理器列表   内存 10 分钟
//   电路 → 容器  内存 60 秒（容器开通状态可能变化）
//   文件内容     按 sha256 缓存（store 是磁盘缓存，见 content-store.js）。每次请求仍先查链上的
//                「路径 → sha256」，所以网站更新后马上能看到新内容；只是没变的文件不用重新下载
//   离线兜底     读链失败时，用 store 里上次读到的电路信息和文件信息，结果标记 stale

import { splitDigits, siteLabel, siteUrl } from './address.js';
import { MAX_IDS_PER_CPU } from './config.js';

const CPU_TTL = 10 * 60 * 1000;
const SITE_TTL = 60 * 1000;
const CONTENT_CACHE_BYTES = 128 * 1024 * 1024;

export function createSites(chain, store = null) {
  let cpuCache = null;
  const siteCache = new Map();
  const content = new Map();
  let contentBytes = 0;
  // 每个容器路径最近一次是怎么读到的（网站信息面板用）
  const served = new Map();

  async function cpus() {
    if (cpuCache && Date.now() - cpuCache.at < CPU_TTL) return cpuCache.list;
    const list = await chain.cpuList();
    cpuCache = { at: Date.now(), list };
    return list;
  }

  /** 电路状态：{exists, owner, container, opened, circuits, stale?}；处理器不存在时 exists=false */
  async function site(tokenId, cpu) {
    const key = `${tokenId}-${cpu}`;
    const hit = siteCache.get(key);
    if (hit && Date.now() - hit.at < SITE_TTL) return hit.info;
    let info;
    try {
      const list = await cpus();
      const circuits = list[cpu];
      info = { exists: false, owner: null, container: null, opened: false, circuits: null };
      if (circuits) info = { ...(await chain.circuitInfos([{ circuits, tokenId }]))[0], circuits };
    } catch (e) {
      const last = store?.lastSite(key);
      if (!last) throw e;
      return { ...last, stale: true };
    }
    siteCache.set(key, { at: Date.now(), info });
    if (info.exists && info.opened) store?.rememberSite(key, info);
    return info;
  }

  function remember(sha, bytes) {
    content.set(sha, bytes);
    contentBytes += bytes.length;
    for (const [k, v] of content) {
      if (contentBytes <= CONTENT_CACHE_BYTES) break;
      content.delete(k);
      contentBytes -= v.length;
    }
  }

  async function cachedBytes(sha) {
    const hit = content.get(sha);
    if (hit) {
      // 刷新 LRU 顺序
      content.delete(sha);
      content.set(sha, hit);
      return hit;
    }
    const disk = store ? await store.get(sha) : null;
    if (disk) remember(sha, disk);
    return disk;
  }

  /**
   * 读文件：返回 {info, bytes, source}；文件不存在返回 null。
   * source：chain 从链上下载；cache 链上哈希没变，用缓存；stale 读链失败，用上次缓存的版本
   */
  async function readFile(container, path) {
    let info;
    try {
      info = await chain.fileInfo(container, path);
    } catch (e) {
      const last = store?.lastFile(container, path);
      const bytes = last && (await cachedBytes(last.sha256));
      if (!bytes) throw e;
      served.set(`${container}:${path}`, { source: 'stale', info: last, at: Date.now() });
      return { info: last, bytes, source: 'stale' };
    }
    if (!info) return null;
    store?.rememberFile(container, path, info);
    let bytes = await cachedBytes(info.sha256);
    let source = 'cache';
    if (!bytes) {
      bytes = await chain.readVerified(container, path, info);
      remember(info.sha256, bytes);
      await store?.put(info.sha256, bytes);
      source = 'chain';
    }
    served.set(`${container}:${path}`, { source, info, at: Date.now() });
    return { info, bytes, source };
  }

  /** 网站信息面板：电路、持有人、容器，以及当前页面文件最近一次的读取情况 */
  async function describe(tokenId, cpu, path) {
    const s = await site(tokenId, cpu);
    const file = s.container ? served.get(`${s.container}:${path}`) ?? null : null;
    return {
      tokenId, cpu, label: siteLabel(tokenId, cpu), url: siteUrl(tokenId, cpu),
      exists: s.exists, owner: s.owner, container: s.container, opened: s.opened, circuits: s.circuits, stale: Boolean(s.stale),
      path, file: file && { ...file.info, source: file.source, at: file.at },
    };
  }

  /** 一组电路里有首页的：items = [{tokenId, cpu, circuits}] → [{tokenId, cpu, label, url, container}] */
  async function withIndex(items) {
    if (!items.length) return [];
    const infos = await chain.circuitInfos(items);
    const opened = [];
    infos.forEach((info, i) => {
      if (info.exists && info.opened && info.container) opened.push({ ...items[i], container: info.container });
    });
    if (!opened.length) return [];
    const files = await chain.fileInfos(opened.map((o) => ({ container: o.container, path: 'index.html' })));
    return opened
      .filter((_, i) => files[i])
      .map((o) => ({ tokenId: o.tokenId, cpu: o.cpu, container: o.container, label: siteLabel(o.tokenId, o.cpu), url: siteUrl(o.tokenId, o.cpu) }));
  }

  /** 12330 → 所有存在处理器的切分里，有 index.html 的网站 */
  async function enumerateDigits(digits) {
    const list = await cpus();
    const items = splitDigits(digits)
      .filter((s) => s.cpu < list.length && list[s.cpu])
      .map((s) => ({ ...s, circuits: list[s.cpu] }));
    const sites = await withIndex(items);
    return { candidates: items.map((s) => siteLabel(s.tokenId, s.cpu)), sites };
  }

  /**
   * 扫描钱包持有的全部电路，返回有 index.html 的网站。
   * onProgress({stage, ...}) 用于界面显示进度。
   */
  async function scanWallet(wallet, onProgress) {
    onProgress?.({ stage: 'cpus' });
    const block = await chain.pinBlock();
    const list = await chain.cpuList(block);
    onProgress?.({ stage: 'balances', total: list.length });
    const held = await chain.holdings(wallet, list, block);
    const found = [];
    const skipped = [];
    for (const h of held) {
      const maxId = await chain.maxTokenId(h.circuits, block);
      if (maxId > MAX_IDS_PER_CPU) { skipped.push({ cpu: h.cpu, balance: h.balance, maxId }); continue; }
      const ids = await chain.ownedIds(h.circuits, wallet, 1, maxId, h.balance, block, (done, total) => {
        onProgress?.({ stage: 'ids', cpu: h.cpu, done, total });
      });
      for (const tokenId of ids) found.push({ tokenId, cpu: h.cpu, circuits: h.circuits });
    }
    onProgress?.({ stage: 'index', total: found.length });
    const sites = await withIndex(found);
    return { circuits: found.length, sites, skipped };
  }

  return { cpus, site, readFile, describe, enumerateDigits, scanWallet };
}
