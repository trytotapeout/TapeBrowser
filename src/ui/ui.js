// 浏览器外壳界面：标签栏、地址栏、新标签页、设置。网页内容由主进程的 WebContentsView 叠在 #content 区域。
'use strict';
(function () {
  const tb = window.tb;
  const $ = (id) => document.getElementById(id);
  let state = { tabs: [], activeId: null };
  let wallet = {};
  let editing = false;
  let settingsOpen = false;
  let noticeTimer = null;

  if (tb.platform === 'darwin') document.body.classList.add('mac');

  const active = () => state.tabs.find((t) => t.id === state.activeId) || null;
  const errText = (e) => String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function renderTabs() {
    const box = $('tabs');
    box.textContent = '';
    for (const t of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t.loading ? ' loading' : '');
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(t.id === state.activeId));
      el.tabIndex = 0;
      el.title = t.url || t.title;
      if (t.favicon && !t.loading) {
        const img = document.createElement('img');
        img.src = t.favicon;
        img.alt = '';
        img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'dot' }));
        el.append(img);
      } else {
        el.append(Object.assign(document.createElement('span'), { className: 'dot' }));
      }
      el.append(Object.assign(document.createElement('span'), { className: 'title', textContent: t.title }));
      const close = Object.assign(document.createElement('button'), { className: 'close', type: 'button', textContent: '×', title: '关闭标签页' });
      close.setAttribute('aria-label', '关闭标签页 ' + t.title);
      // 按下 × 时不能触发标签的 mousedown 切换：切换会重绘标签栏，× 被替换后 click 就丢了
      close.addEventListener('mousedown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => { e.stopPropagation(); tb.invoke('closeTab', t.id); });
      el.append(close);
      el.addEventListener('mousedown', (e) => { if (e.button === 0) select(t.id); });
      el.addEventListener('auxclick', (e) => { if (e.button === 1) tb.invoke('closeTab', t.id); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') select(t.id); });
      box.append(el);
    }
  }

  function select(id) {
    if (settingsOpen) setSettings(false);
    editing = false;
    tb.invoke('activate', id);
  }

  function renderNav() {
    const t = active();
    $('back').disabled = !t || !t.canGoBack;
    $('forward').disabled = !t || !t.canGoForward;
    $('reload').textContent = t && t.loading ? '×' : '↻';
    $('reload').title = t && t.loading ? '停止' : '重新加载';
    if (!editing) $('address').value = t && t.url ? t.url : '';
    document.title = t ? t.title + ' - TapeBrowser' : 'TapeBrowser';
    $('newtab-page').hidden = settingsOpen || Boolean(t && t.url);
    $('settings-page').hidden = !settingsOpen;
  }

  function renderWallet() {
    const b = $('wallet');
    b.className = '';
    if (wallet.ready && wallet.account) {
      const wrongChain = wallet.chainId && wallet.chainId !== '0x38';
      b.textContent = (wrongChain ? '⚠ ' : '') + wallet.account.slice(0, 6) + '…' + wallet.account.slice(-4);
      b.title = (wallet.wallet || '钱包') + (wrongChain ? '：当前不是 BNB Smart Chain' : '：已连接');
      b.classList.add(wrongChain ? 'warn' : 'ready');
    } else if (wallet.connected) {
      b.textContent = '在浏览器里选择钱包…';
      b.title = '桥接页面已打开，请在页面里选择钱包';
    } else {
      b.textContent = '连接钱包';
      b.title = '在系统浏览器里打开钱包桥接页面';
    }
    const s = $('wallet-status');
    if (wallet.ready && wallet.account) s.textContent = `${wallet.wallet || '钱包'} · ${wallet.account} · 链 ${parseInt(wallet.chainId || '0x38', 16)}`;
    else if (wallet.connected) s.textContent = '桥接页面已打开，还没有选择钱包。';
    else s.textContent = '没有连接钱包。';
    $('disconnect-wallet').hidden = !(wallet.ready && wallet.account);
  }

  function notice(text, level) {
    const n = $('notice');
    n.textContent = text;
    n.className = level || 'info';
    n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { n.hidden = true; }, level === 'error' ? 12000 : 6000);
  }

  async function setSettings(on) {
    settingsOpen = on;
    tb.invoke('overlay', on);
    renderNav();
    if (on) await loadSettings();
  }

  async function loadSettings() {
    const s = await tb.invoke('settings');
    $('rpcs').value = s.rpcUrls.join('\n');
    $('rpcs').placeholder = s.defaultRpcs.join('\n');
    $('version').textContent = 'TapeBrowser v' + s.version;
    const ul = $('origins');
    ul.textContent = '';
    if (!s.origins.length) ul.append(Object.assign(document.createElement('li'), { className: 'muted', textContent: '还没有网站连接过钱包。' }));
    for (const o of s.origins) {
      const li = document.createElement('li');
      li.append(Object.assign(document.createElement('span'), { textContent: o.name === o.origin ? o.origin : `${o.name}（${o.origin}）` }));
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: '取消授权' });
      b.addEventListener('click', async () => { await tb.invoke('revoke', o.origin); loadSettings(); });
      li.append(b);
      ul.append(li);
    }
    renderWallet();
  }

  // 内容区位置交给主进程摆放网页
  const content = $('content');
  const reportBounds = () => {
    const r = content.getBoundingClientRect();
    tb.invoke('bounds', { x: r.left, y: r.top, width: r.width, height: r.height });
  };
  new ResizeObserver(reportBounds).observe(content);
  window.addEventListener('resize', reportBounds);

  $('address-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('address').value;
    editing = false;
    if (settingsOpen) setSettings(false);
    $('address').blur();
    tb.invoke('submit', text);
  });
  $('address').addEventListener('input', () => { editing = true; });
  $('address').addEventListener('focus', () => $('address').select());
  $('address').addEventListener('blur', () => { editing = false; renderNav(); });
  $('address').addEventListener('keydown', (e) => { if (e.key === 'Escape') { editing = false; renderNav(); $('address').blur(); } });

  $('newtab').addEventListener('click', () => { tb.invoke('newTab'); focusAddress(); });
  $('back').addEventListener('click', () => tb.invoke('back'));
  $('forward').addEventListener('click', () => tb.invoke('forward'));
  $('reload').addEventListener('click', () => tb.invoke(active() && active().loading ? 'stop' : 'reload'));
  $('settings-btn').addEventListener('click', () => setSettings(!settingsOpen));
  $('wallet').addEventListener('click', () => (wallet.ready ? setSettings(true) : tb.invoke('openBridge')));
  $('open-bridge').addEventListener('click', () => tb.invoke('openBridge'));
  $('disconnect-wallet').addEventListener('click', () => tb.invoke('disconnectWallet'));
  $('save-rpcs').addEventListener('click', async () => {
    const list = $('rpcs').value.split('\n').map((s) => s.trim()).filter(Boolean);
    try { await tb.invoke('saveRpcs', list); $('rpc-msg').textContent = list.length ? '已保存' : '已恢复内置节点'; } catch (e) { $('rpc-msg').textContent = errText(e); }
  });
  for (const b of document.querySelectorAll('.examples button')) {
    b.addEventListener('click', () => { $('address').value = b.dataset.q; tb.invoke('submit', b.dataset.q); });
  }

  function focusAddress() {
    setTimeout(() => { $('address').focus(); $('address').select(); }, 0);
  }

  tb.on('tabs', (s) => { state = s; renderTabs(); renderNav(); });
  tb.on('wallet', (w) => { wallet = w || {}; renderWallet(); });
  tb.on('notice', (n) => notice(n.text, n.level));
  tb.on('command', (name) => {
    if (name === 'focusAddress') focusAddress();
    else if (name === 'settings') setSettings(!settingsOpen);
  });

  renderWallet();
  renderNav();
  tb.invoke('ready');
  reportBounds();
})();
