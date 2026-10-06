// 浏览器身份：一枚指定处理器下的电路就是一个身份（见 config.js 的 IDENTITY_PROCESSORS）。不依赖 Electron。
//
//   列出身份   钱包连上后，在每个身份处理器上查这个钱包持有哪些电路（balanceOf + ownerOf 扫描）
//   登录       用户选一个身份；只记在本机 settings（identity），不需要签名：
//              身份能做什么全由链上决定（容器只认电路持有人），本机记录只是「当前用哪个身份」
//   校验       每次刷新都重新查 ownerOf：电路转走了、或者换了钱包，就自动退出登录
//   容器       身份的容器里的原生币和 BEM 显示在工具栏；容器没开通时提示去开通
//
// deps:
//   chains     { bnb: chain, xlayer: chain, base: chain }（chain.js）
//   sites      createSites() 的返回值（读电路状态和容器资产）
//   store      { get(): saved | null, set(saved | null) }，saved = {network, cpu, tokenId}
//   onChange(view)  身份列表、当前身份或容器资产变化时调用

import { IDENTITY_PROCESSORS, networkByKey } from './config.js';
import { siteLabel, siteUrl } from './address.js';

export const REFRESH_EVERY = 60 * 1000;
// 一个钱包在一个处理器上最多列出这么多个身份
const MAX_IDS = 200;

const keyOf = (x) => `${x.network}:${x.cpu}:${x.tokenId}`;

export function createIdentity({ chains, sites, store, processors = IDENTITY_PROCESSORS, onChange = () => {}, now = Date.now }) {
  const procs = processors.filter((p) => chains[p.network] && networkByKey(p.network));
  let account = null;
  // 当前钱包持有的身份 [{network, cpu, tokenId, ...}]；null 表示还没扫描完
  let list = null;
  let scanError = null;
  let scanning = false;
  // 当前身份的状态 {opened, container, assets, error}
  let current = null;
  let seq = 0;
  let timer = null;

  const describe = (x) => {
    const net = networkByKey(x.network);
    return {
      network: x.network, networkName: net.name, cpu: x.cpu, tokenId: x.tokenId,
      label: siteLabel(x.tokenId, x.cpu, net.area).replace(/\.tape$/, ''), url: siteUrl(x.tokenId, x.cpu, '', net.area),
    };
  };

  function view() {
    const saved = store.get();
    const active = saved && saved.account === account && list ? list.find((x) => keyOf(x) === keyOf(saved)) : null;
    return {
      account,
      scanning,
      error: scanError,
      identities: list ? list.map(describe) : null,
      current: active ? { ...describe(active), ...(current || {}) } : null,
    };
  }

  /** 一个处理器上钱包持有的编号 */
  async function scanProcessor(p, wallet) {
    const chain = chains[p.network];
    const held = (await chain.holdings(wallet, [p.circuits]))[0]?.balance ?? 0;
    if (!held) return [];
    const maxId = await chain.maxTokenId(p.circuits);
    const ids = await chain.ownedIds(p.circuits, wallet, 1, maxId, Math.min(held, MAX_IDS));
    return ids.map((tokenId) => ({ network: p.network, cpu: p.cpu, circuits: p.circuits, tokenId }));
  }

  /** 当前身份的容器状态和资产 */
  async function loadCurrent(x) {
    const net = networkByKey(x.network);
    const info = await sites.site(x.tokenId, x.cpu, net.area);
    if (!info.opened) return { opened: false, container: info.container, owner: info.owner, assets: [] };
    return { opened: true, container: info.container, owner: info.owner, assets: await sites.containerAssets(x.tokenId, x.cpu, net.area) };
  }

  async function refresh() {
    if (!account) return;
    const me = ++seq;
    const who = account;
    scanning = true;
    onChange(view());
    const settled = await Promise.allSettled(procs.map((p) => scanProcessor(p, who)));
    if (me !== seq || who !== account) return;
    const found = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const failed = settled.filter((r) => r.status === 'rejected');
    // 全部失败时保留上次的列表，避免网络抖动把用户踢下线
    if (failed.length === settled.length && settled.length) {
      scanError = String(failed[0].reason?.message || failed[0].reason);
    } else {
      scanError = failed.length ? String(failed[0].reason?.message || failed[0].reason) : null;
      list = found;
      // 当前身份已经不在这个钱包里了（转走、换了钱包）：退出登录
      const saved = store.get();
      if (saved && saved.account === who && !found.some((x) => keyOf(x) === keyOf(saved))) {
        // 只有扫描到了这个身份所在的处理器、而且确实不在了，才退出；那个处理器读失败就先保留
        const procOk = settled.some((r, i) => r.status === 'fulfilled' && procs[i].network === saved.network && procs[i].cpu === saved.cpu);
        if (procOk) store.set(null);
      }
    }
    const saved = store.get();
    const active = saved && saved.account === who && list ? list.find((x) => keyOf(x) === keyOf(saved)) : null;
    if (active) {
      try { current = await loadCurrent(active); } catch (e) { current = { ...(current || {}), error: String(e?.message || e) }; }
    } else {
      current = null;
    }
    if (me !== seq || who !== account) return;
    scanning = false;
    onChange(view());
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!account) return;
    timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_EVERY);
    timer.unref?.();
  }

  return {
    /** 钱包当前地址（小写）；null 表示没连接 */
    setAccount(a) {
      const next = a ? String(a).toLowerCase() : null;
      if (next === account) return;
      account = next;
      list = null;
      current = null;
      scanError = null;
      seq++;
      // 换了钱包：上一个钱包的登录不再有效
      const saved = store.get();
      if (saved && saved.account !== next && next) store.set(null);
      onChange(view());
      schedule();
      refresh().catch(() => {});
    },

    /** 用某个身份登录；返回新的 view。不是当前钱包持有的身份会被拒绝 */
    async login({ network, cpu, tokenId }) {
      const x = list && list.find((i) => keyOf(i) === keyOf({ network, cpu: Number(cpu), tokenId: Number(tokenId) }));
      if (!x) throw new Error('当前钱包没有持有这个身份');
      store.set({ network: x.network, cpu: x.cpu, tokenId: x.tokenId, account, at: now() });
      current = null;
      onChange(view());
      await refresh();
      return view();
    },

    logout() {
      store.set(null);
      current = null;
      onChange(view());
      return view();
    },

    refresh,
    view,
    stop() { clearInterval(timer); timer = null; },
  };
}
