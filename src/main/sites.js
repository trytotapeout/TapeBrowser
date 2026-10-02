// 电路网站的解析、读取、枚举与钱包扫描。不依赖 Electron。
//
// 缓存：
//   处理器列表   内存 10 分钟
//   电路 → 容器  内存 60 秒（容器开通状态可能变化）
//   文件内容     按 sha256 缓存（store 是磁盘缓存，见 content-store.js）。每次请求仍先查链上的
//                「路径 → sha256」，所以网站更新后马上能看到新内容；只是没变的文件不用重新下载
//   离线兜底     读链失败时，用 store 里上次读到的电路信息和文件信息，结果标记 stale
//
// 多链：chains = { bnb: chain, xlayer: chain, base: chain }（键是 config.js 里网络的 key），
// 网站用区号区分（null = BNB）。X Layer 和 Base 的合约地址相同，同一个容器地址在两条链上可能都存在，
// 所以文件信息按「网络 + 容器」记。

import { splitDigits, siteLabel, siteUrl, siteHost } from './address.js';
import { MAX_IDS_PER_CPU, NETWORKS, networkByArea } from './config.js';

const CPU_TTL = 10 * 60 * 1000;
const SITE_TTL = 60 * 1000;
const CONTENT_CACHE_BYTES = 128 * 1024 * 1024;

export function createSites(chains, store = null) {
  // 兼容只传一个 chain（BNB）的用法
  if (typeof chains?.cpuList === 'function') chains = { bnb: chains };
  const netOf = (area) => {
    const net = networkByArea(area);
    if (!net || !chains[net.key]) throw new Error(`不支持的区号 ${area}`);
    return net;
  };
  const chainOf = (area) => chains[netOf(area).key];
  const enabled = () => NETWORKS.filter((n) => chains[n.key]);
  // 文件信息、读取记录的键：BNB 保持原来的容器地址，其他链加网络前缀
  const fileKey = (container, area) => (area === null || area === undefined ? container : `${netOf(area).key}/${container}`);
  const cpuCache = new Map();
  const siteCache = new Map();
  const content = new Map();
  let contentBytes = 0;
  // 每个容器路径最近一次是怎么读到的（网站信息面板用）
  const served = new Map();

  async function cpus(area = null) {
    const k = netOf(area).key;
    const hit = cpuCache.get(k);
    if (hit && Date.now() - hit.at < CPU_TTL) return hit.list;
    const list = await chainOf(area).cpuList();
    cpuCache.set(k, { at: Date.now(), list });
    return list;
  }

  /** 电路状态：{exists, owner, container, opened, circuits, stale?}；处理器不存在时 exists=false */
  async function site(tokenId, cpu, area = null) {
    const key = siteHost(tokenId, cpu, area);
    const hit = siteCache.get(key);
    if (hit && Date.now() - hit.at < SITE_TTL) return hit.info;
    let info;
    try {
      const list = await cpus(area);
      const circuits = list[cpu];
      info = { exists: false, owner: null, container: null, opened: false, circuits: null };
      if (circuits) info = { ...(await chainOf(area).circuitInfos([{ circuits, tokenId }]))[0], circuits };
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
  async function readFile(container, path, area = null) {
    const fk = fileKey(container, area);
    const chain = chainOf(area);
    let info;
    try {
      info = await chain.fileInfo(container, path);
    } catch (e) {
      const last = store?.lastFile(fk, path);
      const bytes = last && (await cachedBytes(last.sha256));
      if (!bytes) throw e;
      served.set(`${fk}:${path}`, { source: 'stale', info: last, at: Date.now() });
      return { info: last, bytes, source: 'stale' };
    }
    if (!info) return null;
    store?.rememberFile(fk, path, info);
    let bytes = await cachedBytes(info.sha256);
    let source = 'cache';
    if (!bytes) {
      bytes = await chain.readVerified(container, path, info);
      remember(info.sha256, bytes);
      await store?.put(info.sha256, bytes);
      source = 'chain';
    }
    served.set(`${fk}:${path}`, { source, info, at: Date.now() });
    return { info, bytes, source };
  }

  /** 网站信息面板：电路、持有人、容器，以及当前页面文件最近一次的读取情况 */
  async function describe(tokenId, cpu, path, area = null) {
    const net = netOf(area);
    const s = await site(tokenId, cpu, area);
    const file = s.container ? served.get(`${fileKey(s.container, area)}:${path}`) ?? null : null;
    return {
      tokenId, cpu, area, network: net.name, label: siteLabel(tokenId, cpu, area), url: siteUrl(tokenId, cpu, '', area),
      exists: s.exists, owner: s.owner, container: s.container, opened: s.opened, circuits: s.circuits, stale: Boolean(s.stale),
      path, file: file && { ...file.info, source: file.source, at: file.at },
    };
  }

  /** 同一条链上的一组电路里有首页的：items = [{tokenId, cpu, circuits}] → [{tokenId, cpu, area, label, url, container}] */
  async function withIndex(items, area = null) {
    if (!items.length) return [];
    const chain = chainOf(area);
    const infos = await chain.circuitInfos(items);
    const opened = [];
    infos.forEach((info, i) => {
      if (info.exists && info.opened && info.container) opened.push({ ...items[i], container: info.container });
    });
    if (!opened.length) return [];
    const files = await chain.fileInfos(opened.map((o) => ({ container: o.container, path: 'index.html' })));
    return opened
      .filter((_, i) => files[i])
      .map((o) => ({ tokenId: o.tokenId, cpu: o.cpu, area, network: netOf(area).name, container: o.container, label: siteLabel(o.tokenId, o.cpu, area), url: siteUrl(o.tokenId, o.cpu, '', area) }));
  }

  /**
   * 对每条已启用的链并行执行 fn(net)。一条链失败不影响其他链：
   * 返回 {results: [{net, value}], errors: [{net, error}]}；全部失败时抛出第一个错误
   */
  async function eachNetwork(fn, nets = enabled()) {
    const settled = await Promise.allSettled(nets.map((net) => fn(net)));
    const results = [];
    const errors = [];
    settled.forEach((r, i) => (r.status === 'fulfilled' ? results.push({ net: nets[i], value: r.value }) : errors.push({ net: nets[i], error: r.reason })));
    if (!results.length && errors.length) throw errors[0].error;
    return { results, errors };
  }

  /** 12248 → 所有存在处理器的切分（含 1.2.248 这种带区号的）里，有 index.html 的网站 */
  async function enumerateDigits(digits) {
    const all = splitDigits(digits).filter((s) => chains[networkByArea(s.area)?.key]);
    const nets = enabled().filter((n) => all.some((s) => s.area === n.area));
    const { results, errors } = await eachNetwork(async (net) => {
      const list = await cpus(net.area);
      const items = all
        .filter((s) => s.area === net.area && s.cpu < list.length && list[s.cpu])
        .map((s) => ({ ...s, circuits: list[s.cpu] }));
      return { items, sites: await withIndex(items, net.area) };
    }, nets);
    const order = (s) => all.findIndex((x) => x.tokenId === s.tokenId && x.cpu === s.cpu && x.area === s.area);
    const candidates = results.flatMap((r) => r.value.items).sort((a, b) => order(a) - order(b));
    const sites = results.flatMap((r) => r.value.sites).sort((a, b) => order(a) - order(b));
    return {
      candidates: candidates.map((s) => siteLabel(s.tokenId, s.cpu, s.area)),
      sites,
      failed: errors.map((e) => ({ network: e.net.name, message: String(e.error?.message || e.error) })),
    };
  }

  /** 一条链上扫描钱包持有的电路 */
  async function scanWalletOn(net, wallet, onProgress) {
    const chain = chains[net.key];
    const progress = (p) => onProgress?.({ ...p, network: net.name });
    progress({ stage: 'cpus' });
    const block = await chain.pinBlock();
    const list = await chain.cpuList(block);
    progress({ stage: 'balances', total: list.length });
    const held = await chain.holdings(wallet, list, block);
    const found = [];
    const skipped = [];
    for (const h of held) {
      const maxId = await chain.maxTokenId(h.circuits, block);
      if (maxId > MAX_IDS_PER_CPU) { skipped.push({ cpu: h.cpu, area: net.area, network: net.name, balance: h.balance, maxId }); continue; }
      const ids = await chain.ownedIds(h.circuits, wallet, 1, maxId, h.balance, block, (done, total) => {
        progress({ stage: 'ids', cpu: h.cpu, done, total });
      });
      for (const tokenId of ids) found.push({ tokenId, cpu: h.cpu, circuits: h.circuits });
    }
    progress({ stage: 'index', total: found.length });
    return { circuits: found.length, sites: await withIndex(found, net.area), skipped };
  }

  /**
   * 在所有链上扫描钱包持有的全部电路，返回有 index.html 的网站。
   * onProgress({stage, network, ...}) 用于界面显示进度。
   */
  async function scanWallet(wallet, onProgress) {
    const { results, errors } = await eachNetwork((net) => scanWalletOn(net, wallet, onProgress));
    return {
      circuits: results.reduce((n, r) => n + r.value.circuits, 0),
      sites: results.flatMap((r) => r.value.sites),
      skipped: results.flatMap((r) => r.value.skipped),
      failed: errors.map((e) => ({ network: e.net.name, message: String(e.error?.message || e.error) })),
    };
  }

  return { cpus, site, readFile, describe, enumerateDigits, scanWallet, networks: enabled };
}
