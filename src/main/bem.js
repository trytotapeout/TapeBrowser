// 钱包在各条链上的 BEM 余额（工具栏钱包按钮旁边显示）。不依赖 Electron。
//
// 用每条链的内置节点池直接读 BEM 合约的 balanceOf，不经过钱包扩展、不调用第三方接口。
// 钱包连上、换地址时立即刷新，之后每 REFRESH_EVERY 刷新一次；一条链读失败不影响其他链。
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
  let account = null;
  // key → { balance: BigInt } | { error }
  let results = {};
  let at = 0;
  let seq = 0;
  let timer = null;

  function view() {
    if (!account) return null;
    const per = nets.map((n) => {
      const r = results[n.key];
      return { key: n.key, name: n.name, balance: r && 'balance' in r ? formatBem(r.balance) : null, error: r?.error ?? null };
    });
    const ok = nets.filter((n) => results[n.key] && 'balance' in results[n.key]);
    const total = ok.reduce((s, n) => s + results[n.key].balance, 0n);
    return { account, total: ok.length ? formatBem(total) : null, loading: !at, networks: per, at };
  }

  async function refresh() {
    if (!account) return;
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
      results = {};
      at = 0;
      seq++;
      onChange(view());
      schedule();
      refresh().catch(() => {});
    },
    refresh,
    view,
    stop() { clearInterval(timer); timer = null; },
  };
}
