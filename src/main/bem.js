// BEM 价格和钱包在各条链上的 BEM 余额（工具栏钱包按钮旁边显示）。不依赖 Electron。
//
// 价格：直接读 PancakeSwap V3 BEM/USDT 池的当前成交价（config.js 的 bemPricePool），USDT 按 1 美元计。
//       只是一个池子的即时价格，交易量小的时候可能被拉高或砸低，仅供参考
// 余额：用每条链的内置节点池直接读 BEM 合约的 balanceOf，钱包连上后才读
// 都不经过钱包扩展、不调用第三方接口。启动、钱包连上、换地址时立即刷新，之后每 REFRESH_EVERY 刷新一次；
// 一条链读失败不影响其他链
//
//   chains    { bnb: chain, xlayer: chain, base: chain }（chain.js）
//   networks  config.js 里的网络列表，只查 bem 地址不为空的链
//   onChange(view)  余额有变化时调用，view 见 view()

export const REFRESH_EVERY = 60 * 1000;
export const BEM_DECIMALS = 8;

/** 最小单位 → 显示用的字符串：最多 2 位小数，千分位 */
export function formatBem(v, decimals = BEM_DECIMALS) {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const cents = ((v % base) * 100n) / base;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return cents ? `${w}.${cents.toString().padStart(2, '0').replace(/0$/, '')}` : w;
}

export function createBemBalances({ chains, networks, onChange = () => {}, now = Date.now }) {
  const nets = networks.filter((n) => n.bem && chains[n.key]);
  const priceNet = networks.find((n) => n.bemPricePool && chains[n.key]) || null;
  // { usd } | { error } | null（还没读到）
  let price = null;
  let account = null;
  // key → { balance: BigInt } | { error }
  let results = {};
  let at = 0;
  let seq = 0;
  let timer = null;

  function view() {
    const p = price && 'usd' in price ? price.usd : null;
    if (!account) return { price: p, balance: null };
    const per = nets.map((n) => {
      const r = results[n.key];
      return { key: n.key, name: n.name, balance: r && 'balance' in r ? formatBem(r.balance) : null, error: r?.error ?? null };
    });
    const ok = nets.filter((n) => results[n.key] && 'balance' in results[n.key]);
    const total = ok.reduce((s, n) => s + results[n.key].balance, 0n);
    // 余额折合美元：BEM 是 8 位精度，先转成浮点数再乘价格
    const usd = ok.length && p !== null ? (Number(total) / 10 ** BEM_DECIMALS) * p : null;
    return { price: p, balance: { account, total: ok.length ? formatBem(total) : null, usd, loading: !at, networks: per, at } };
  }

  async function readPrice() {
    if (!priceNet) return;
    const pp = priceNet.bemPricePool;
    try {
      const usd = await chains[priceNet.key].v3Price(pp.pool, priceNet.bem, BEM_DECIMALS, pp.quoteDecimals);
      price = Number.isFinite(usd) && usd > 0 ? { usd } : { error: '价格不合法' };
    } catch (e) { price = { error: String(e?.message || e) }; }
  }

  async function refresh() {
    await readPrice();
    if (!account) { onChange(view()); return; }
    const me = ++seq;
    const who = account;
    const settled = await Promise.allSettled(nets.map((n) => chains[n.key].tokenBalance(n.bem, who)));
    // 读的过程中换了地址或断开：丢掉旧结果
    if (me !== seq || who !== account) return;
    const next = {};
    settled.forEach((r, i) => { next[nets[i].key] = r.status === 'fulfilled' ? { balance: r.value } : { error: String(r.reason?.message || r.reason) }; });
    results = next;
    at = now();
    onChange(view());
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_EVERY);
    timer.unref?.();
  }

  return {
    /** 开始定时刷新价格（没连钱包也显示价格） */
    start() { schedule(); refresh().catch(() => {}); },
    /** 钱包当前地址（小写）；null 表示没连接 */
    setAccount(a) {
      const next = a ? String(a).toLowerCase() : null;
      if (next === account) return;
      account = next;
      results = {};
      at = 0;
      seq++;
      onChange(view());
      refresh().catch(() => {});
    },
    refresh,
    view,
    stop() { clearInterval(timer); timer = null; },
  };
}
