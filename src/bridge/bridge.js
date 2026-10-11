// 桥接页面：运行在系统浏览器里（http://127.0.0.1:<端口>/?t=<口令>），
// 把 TapeBrowser 发来的钱包请求交给这里选中的钱包扩展（EIP-6963 / window.ethereum）。
'use strict';
(function () {
  const token = new URLSearchParams(location.search).get('t') || '';
  const $ = (id) => document.getElementById(id);
  const providers = new Map(); // key → {info, provider}
  let current = null; // {key, info, provider}
  let accounts = [];
  let chainId = null;
  let ws = null;
  const PICK_KEY = 'tapebrowser:wallet';
  // TapeKit 网站所在的三条链；其他链只显示编号
  const CHAINS = { '0x38': 'BNB Chain', '0xc4': 'X Layer', '0x2105': 'Base', '0x1': 'Ethereum', '0x61': 'BSC Testnet' };
  const TAPE_CHAINS = new Set(['0x38', '0xc4', '0x2105']);

  function log(text) {
    const li = document.createElement('li');
    li.textContent = new Date().toLocaleTimeString() + '  ' + text;
    $('log').prepend(li);
    while ($('log').children.length > 100) $('log').lastChild.remove();
  }

  function render() {
    const linked = ws && ws.readyState === WebSocket.OPEN;
    $('link').textContent = linked ? '已连接' : '未连接（等待 TapeBrowser）';
    $('link').className = linked ? 'ok' : 'bad';
    $('wallet').textContent = current ? current.info.name : '未选择';
    $('account').textContent = accounts[0] || '—';
    $('chain').textContent = chainId ? (CHAINS[chainId] || '链 ' + parseInt(chainId, 16)) : '—';
    $('chain').className = chainId && !TAPE_CHAINS.has(chainId) ? 'bad' : '';
    $('disconnect').hidden = !current;
    renderProviders();
  }

  function renderProviders() {
    const box = $('providers');
    box.textContent = '';
    if (!providers.size) {
      $('pick-hint').textContent = '没有找到钱包扩展。请在这个浏览器里安装 MetaMask 等钱包扩展后刷新本页面。';
      return;
    }
    $('pick-hint').textContent = current ? '当前使用 ' + current.info.name + '，可以换成其他钱包：' : '选择要给 TapeBrowser 使用的钱包：';
    for (const [key, p] of providers) {
      const b = document.createElement('button');
      b.type = 'button';
      if (typeof p.info.icon === 'string' && p.info.icon.startsWith('data:image/')) {
        const img = document.createElement('img');
        img.src = p.info.icon;
        img.alt = '';
        b.append(img);
      }
      b.append(document.createTextNode(p.info.name + (current && current.key === key ? '（使用中）' : '')));
      b.addEventListener('click', () => pick(key, true));
      box.append(b);
    }
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function report() {
    send({ type: 'state', ready: Boolean(current), wallet: current ? current.info.name : null, accounts, chainId });
    render();
  }

  const onAccounts = (a) => { accounts = Array.isArray(a) ? a : []; log('钱包地址变化：' + (accounts[0] || '无')); report(); };
  const onChain = (c) => { chainId = String(c).toLowerCase(); log('网络变化：' + chainId); report(); };

  async function pick(key, byUser) {
    const p = providers.get(key);
    if (!p) return;
    if (current && current.provider.removeListener) {
      current.provider.removeListener('accountsChanged', onAccounts);
      current.provider.removeListener('chainChanged', onChain);
    }
    current = { key, info: p.info, provider: p.provider };
    localStorage.setItem(PICK_KEY, key);
    p.provider.on?.('accountsChanged', onAccounts);
    p.provider.on?.('chainChanged', onChain);
    try {
      chainId = String(await p.provider.request({ method: 'eth_chainId' })).toLowerCase();
      // 用户点击时直接请求授权；自动恢复时只读已授权的地址，不弹窗
      accounts = await p.provider.request({ method: byUser ? 'eth_requestAccounts' : 'eth_accounts' }) || [];
    } catch (e) {
      log('钱包错误：' + (e && e.message ? e.message : e));
      accounts = [];
    }
    log('使用钱包 ' + p.info.name);
    report();
  }

  function addProvider(info, provider) {
    const key = info.rdns || info.uuid || info.name;
    if (!key || providers.has(key)) return;
    providers.set(key, { info: { name: String(info.name || key).slice(0, 64), icon: info.icon, rdns: info.rdns }, provider });
    const saved = localStorage.getItem(PICK_KEY);
    if (!current && (saved === key)) pick(key, false);
    render();
  }

  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = e.detail;
    if (d && d.info && d.provider) addProvider(d.info, d.provider);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  // 不支持 EIP-6963 的老钱包
  setTimeout(() => {
    if (!providers.size && window.ethereum) addProvider({ name: window.ethereum.isMetaMask ? 'MetaMask' : '浏览器钱包', rdns: 'legacy.window.ethereum' }, window.ethereum);
    if (!current && providers.size === 1) pick(providers.keys().next().value, false);
    render();
  }, 500);

  function disconnect(fromApp) {
    if (current && current.provider.removeListener) {
      current.provider.removeListener('accountsChanged', onAccounts);
      current.provider.removeListener('chainChanged', onChain);
    }
    // 尽量撤销扩展里的授权（MetaMask 等支持；不支持的钱包需要在扩展里手动断开站点）
    current?.provider.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {});
    current = null;
    accounts = [];
    chainId = null;
    localStorage.removeItem(PICK_KEY);
    log(fromApp ? '已从 TapeBrowser 断开钱包' : '已断开钱包');
    report();
  }

  $('disconnect').addEventListener('click', () => disconnect(false));

  function safeError(e) {
    return { code: Number(e && e.code) || -32603, message: String((e && e.message) || e || '钱包错误'), data: e && e.data !== undefined ? JSON.parse(JSON.stringify(e.data)) : undefined };
  }

  async function refreshChain() {
    try {
      const c = String(await current.provider.request({ method: 'eth_chainId' })).toLowerCase();
      if (c !== chainId) { chainId = c; log('网络变化：' + chainId); report(); }
    } catch { /* 读不到就等钱包自己的 chainChanged */ }
  }

  async function onRequest(msg) {
    const who = msg.origin ? msg.origin + ' ' : '';
    log(who + '请求 ' + msg.method);
    if (!current) { send({ type: 'response', id: msg.id, error: { code: 4900, message: '桥接页面没有选择钱包' } }); return; }
    try {
      const result = await current.provider.request({ method: msg.method, params: msg.params });
      if (msg.method === 'eth_requestAccounts') { accounts = result || []; report(); }
      // 有的钱包切链成功后不发 chainChanged（或者很晚才发），自己再读一次当前的链，免得 TapeBrowser 一直以为链不对
      if (msg.method === 'wallet_switchEthereumChain' || msg.method === 'wallet_addEthereumChain') {
        // 切链成功就说明钱包已经在目标链上（EIP-3326）；有的钱包紧接着读 eth_chainId 还是旧链，先按目标链记下
        const want = msg.method === 'wallet_switchEthereumChain' && msg.params && msg.params[0] && msg.params[0].chainId;
        if (typeof want === 'string' && /^0x[0-9a-fA-F]+$/.test(want) && want.toLowerCase() !== chainId) {
          chainId = want.toLowerCase(); log('网络变化：' + chainId); report();
        } else await refreshChain();
      }
      send({ type: 'response', id: msg.id, result: result === undefined ? null : result });
    } catch (e) {
      log(who + msg.method + ' 失败：' + safeError(e).message);
      send({ type: 'response', id: msg.id, error: safeError(e) });
    }
  }

  function open() {
    ws = new WebSocket('ws://' + location.host + '/ws?t=' + encodeURIComponent(token));
    ws.onopen = () => { log('已连接 TapeBrowser'); report(); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'request') onRequest(msg);
      else if (msg.type === 'disconnect') disconnect(true);
    };
    ws.onclose = (e) => {
      render();
      // 4000：被更新的桥接页面替换，本页不再重连
      if (e.code === 4000) { log('另一个桥接页面已接管，本页面可以关闭'); return; }
      setTimeout(open, 2000);
    };
  }
  open();
  render();
})();
