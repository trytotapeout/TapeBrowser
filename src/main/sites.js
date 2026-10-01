// 电路网站的解析、读取、枚举与钱包扫描。不依赖 Electron。
//
// 缓存（只在内存里，进程退出即清空）：
//   处理器列表   10 分钟
//   电路 → 容器  60 秒（容器开通状态可能变化）
//   文件内容     按 sha256 缓存，内容寻址不会过期；总量超过上限时淘汰最早的

import { splitDigits, siteLabel, siteUrl } from './address.js';
import { MAX_IDS_PER_CPU } from './config.js';

const CPU_TTL = 10 * 60 * 1000;
const SITE_TTL = 60 * 1000;
const CONTENT_CACHE_BYTES = 128 * 1024 * 1024;

export function createSites(chain) {
  let cpuCache = null;
  const siteCache = new Map();
  const content = new Map();
  let contentBytes = 0;

  async function cpus() {
    if (cpuCache && Date.now() - cpuCache.at < CPU_TTL) return cpuCache.list;
    const list = await chain.cpuList();
    cpuCache = { at: Date.now(), list };
    return list;
  }

  /** 电路状态：{exists, owner, container, opened, circuits}；处理器不存在时 exists=false */
  async function site(tokenId, cpu) {
    const key = `${tokenId}-${cpu}`;
    const hit = siteCache.get(key);
    if (hit && Date.now() - hit.at < SITE_TTL) return hit.info;
    const list = await cpus();
    const circuits = list[cpu];
    let info = { exists: false, owner: null, container: null, opened: false, circuits: null };
    if (circuits) info = { ...(await chain.circuitInfos([{ circuits, tokenId }]))[0], circuits };
    siteCache.set(key, { at: Date.now(), info });
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

  /** 读文件：返回 {info, bytes}；文件不存在返回 null */
  async function readFile(container, path) {
    const info = await chain.fileInfo(container, path);
    if (!info) return null;
    const cached = content.get(info.sha256);
    if (cached) {
      // 刷新 LRU 顺序
      content.delete(info.sha256);
      content.set(info.sha256, cached);
      return { info, bytes: cached };
    }
    const bytes = await chain.readVerified(container, path, info);
    remember(info.sha256, bytes);
    return { info, bytes };
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

  return { cpus, site, readFile, enumerateDigits, scanWallet };
}
