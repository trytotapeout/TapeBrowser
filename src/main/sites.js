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
import { MAX_IDS_PER_CPU, NETWORKS, PUBLISH_NETWORKS, networkByArea, networkByKey } from './config.js';
import { fail, CHAIN_UNSUPPORTED } from './publish-errors.js';

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

  /**
   * 网站容器里的全部文件（安全体检用）：{site, files: [{path, size, sha256, updatedAt}], total, read(path)}。
   * 只列文件，不读内容；read 走 readFile，校验 sha256、复用内容缓存
   */
  async function siteFiles(tokenId, cpu, area = null) {
    const s = await site(tokenId, cpu, area);
    if (!s.exists || !s.opened || !s.container) return { site: s, files: [], total: 0, read: async () => null };
    const chain = chainOf(area);
    const { paths, total } = await chain.allPaths(s.container);
    const infos = paths.length ? await chain.fileInfos(paths.map((path) => ({ container: s.container, path }))) : [];
    const files = [];
    paths.forEach((path, i) => { const f = infos[i]; if (f) files.push({ path, size: f.size, sha256: f.sha256, updatedAt: f.updatedAt }); });
    return { site: s, files, total, read: async (path) => (await readFile(s.container, path, area))?.bytes ?? null };
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

  const verified = new Map();
  const VERIFY_TTL = 10 * 60 * 1000;
  const lc = (x) => String(x || '').toLowerCase();

  /**
   * 多节点交叉校验当前页面：另外两个不同的节点各自读「电路 → 容器」和这个文件的 sha256，
   * 和显示网页用的结果比对。返回 {status, nodes, mismatches}：
   *   ok        两个节点结果一致，且和显示的内容一致
   *   mismatch  有节点结果不一致（也可能网站刚好在两次读取之间更新）
   *   single    可用节点不够两个，没法交叉校验
   *   skip      电路没有开通、或页面没有从链上读到
   * 同一个页面、同一个 sha256 十分钟内不重复校验
   */
  async function verify(tokenId, cpu, path, area = null) {
    const s = await site(tokenId, cpu, area);
    if (s.stale || !s.exists || !s.opened || !s.container) return { status: 'skip' };
    const file = served.get(`${fileKey(s.container, area)}:${path}`);
    if (!file || file.source === 'stale') return { status: 'skip' };
    const key = `${siteHost(tokenId, cpu, area)}:${path}:${file.info.sha256}`;
    const hit = verified.get(key);
    if (hit && Date.now() - hit.at < VERIFY_TTL) return hit;
    const reads = await chainOf(area).crossRead(s.circuits, tokenId, s.container, path);
    const mismatches = [];
    for (const r of reads) {
      if (lc(r.container) !== lc(s.container) || !r.opened) mismatches.push({ node: r.node, field: 'container', got: r.container });
      else if (lc(r.sha256) !== lc(file.info.sha256)) mismatches.push({ node: r.node, field: 'sha256', got: r.sha256 });
    }
    const out = { status: mismatches.length ? 'mismatch' : reads.length < 2 ? 'single' : 'ok', nodes: reads.map((r) => r.node), mismatches, at: Date.now() };
    // 不一致的结果不缓存，下次打开面板重新校验
    if (out.status !== 'mismatch') verified.set(key, out);
    return out;
  }

  /**
   * 容器里的资产（网站信息面板用）：网站所在链的原生币，以及这条链上有 BEM 时的 BEM 余额。
   * 返回 [{symbol, amount, decimals}]（最小单位，字符串）；一项读失败时这一项带 error
   */
  async function containerAssets(tokenId, cpu, area = null) {
    const net = netOf(area);
    const chain = chainOf(area);
    const s = await site(tokenId, cpu, area);
    if (!s.container) return [];
    const items = [{ symbol: net.currency, decimals: 18, read: () => chain.nativeBalance(s.container) }];
    if (net.bem) items.push({ symbol: 'BEM', decimals: 8, read: () => chain.tokenBalance(net.bem, s.container) });
    const settled = await Promise.allSettled(items.map((x) => x.read()));
    return items.map((x, i) => (settled[i].status === 'fulfilled'
      ? { symbol: x.symbol, decimals: x.decimals, amount: settled[i].value.toString() }
      : { symbol: x.symbol, decimals: x.decimals, error: String(settled[i].reason?.message || settled[i].reason) }));
  }

  /** 网站首页的文件信息（持有人、首页是否更新的记录用）：{owner, sha256}；没有开通或没有首页时 sha256 为 null */
  async function indexInfo(tokenId, cpu, area = null) {
    const s = await site(tokenId, cpu, area);
    if (!s.exists) return null;
    const f = s.opened && s.container ? await chainOf(area).fileInfo(s.container, 'index.html') : null;
    return { owner: s.owner, sha256: f?.sha256 ?? null };
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

  /**
   * 一条链上钱包持有的全部电路（不管有没有开通）：{found: [{tokenId, cpu, circuits}], skipped, block, progress}。
   * id 太多的处理器放进 skipped 不逐个查；block 是这次扫描固定的区块，后续读取沿用
   */
  async function ownedCircuits(net, wallet, onProgress) {
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
    return { found, skipped, block, progress };
  }

  /** 一条链上扫描钱包持有的电路，只返回有首页的网站 */
  async function scanWalletOn(net, wallet, onProgress) {
    const { found, skipped, progress } = await ownedCircuits(net, wallet, onProgress);
    progress({ stage: 'index', total: found.length });
    return { circuits: found.length, sites: await withIndex(found, net.area), skipped };
  }

  /**
   * 发布用：钱包在一条链上持有的全部电路，包括没开通的、开通了没首页的。
   * 返回 {circuits: [{tokenId, cpu, circuits, label, container, opened, hasIndex}], skipped}，按处理器、编号排序（即 label 顺序）。
   * 只支持 PUBLISH_NETWORKS 里的链；进度事件和 scanWallet 相同，读电路信息前多一个 {stage: 'circuits', total}
   */
  async function circuitsOf(netKey, wallet, onProgress) {
    const net = networkByKey(netKey);
    if (!net || !PUBLISH_NETWORKS.includes(net.key)) throw fail(CHAIN_UNSUPPORTED, '这条链暂时不支持发布');
    const chain = chainOf(net.area);
    const { found, skipped, block, progress } = await ownedCircuits(net, wallet, onProgress);
    progress({ stage: 'circuits', total: found.length });
    if (!found.length) return { circuits: [], skipped };
    const infos = await chain.circuitInfos(found, block);
    const circuits = found.map((c, i) => ({
      tokenId: c.tokenId,
      cpu: c.cpu,
      circuits: c.circuits,
      label: siteLabel(c.tokenId, c.cpu, net.area),
      container: infos[i].container,
      opened: !!(infos[i].exists && infos[i].opened && infos[i].container),
      hasIndex: false,
    }));
    const opened = circuits.filter((c) => c.opened);
    if (opened.length) {
      const files = await chain.fileInfos(opened.map((c) => ({ container: c.container, path: 'index.html' })), block);
      opened.forEach((c, i) => { c.hasIndex = !!files[i]; });
    }
    circuits.sort((a, b) => a.cpu - b.cpu || Number(a.tokenId) - Number(b.tokenId));
    return { circuits, skipped };
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

  return { cpus, site, readFile, siteFiles, describe, verify, indexInfo, containerAssets, enumerateDigits, scanWallet, circuitsOf, networks: enabled };
}
