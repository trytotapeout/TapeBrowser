// 浏览器外壳界面：标签栏、地址栏、新标签页、设置。网页内容由主进程的 WebContentsView 叠在 #content 区域。
'use strict';
(function () {
  const tb = window.tb;
  const $ = (id) => document.getElementById(id);
  let state = { tabs: [], activeId: null };
  let wallet = {};
  let library = { history: [], bookmarks: [] };
  let dir = { sites: [], status: { count: 0, lastFullScan: 0, running: false, progress: null } };
  // 用户手动选过的分栏；没选过时有最近访问就显示最近访问，否则显示全部网站
  let panel = null;
  let dirLimit = 200;
  let findOpen = false;
  let siteOpen = false;
  let siteInfo = null;
  // 上次查询网站信息时的 标签 id + 网址 + 是否在加载，变化时才重新查询
  let siteKey = '';
  let editing = false;
  let settingsOpen = false;
  let noticeTimer = null;

  if (tb.platform === 'darwin') document.body.classList.add('mac');

  const active = () => state.tabs.find((t) => t.id === state.activeId) || null;
  // TapeKit 网站所在的三条链
  const CHAINS = { '0x38': 'BNB Chain', '0xc4': 'X Layer', '0x2105': 'Base' };
  const NET_NAMES = { bnb: 'BNB Chain', xlayer: 'X Layer', base: 'Base' };
  const NET_SHORT = { bnb: 'BNB', xlayer: 'X Layer', base: 'Base' };
  /** 当前标签是电路网站时，它所在链的 chainId：tape://1-2-344 → X Layer */
  function tabChain(t) {
    const m = /^tape:\/\/\d+-(?:(\d+)-)?\d+(?:[/?#]|$)/i.exec((t && t.url) || '');
    if (!m) return null;
    return { 2: '0xc4', 3: '0x2105' }[m[1]] || (m[1] ? null : '0x38');
  }
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
    const zoom = t && t.url ? t.zoom : 100;
    $('zoom').hidden = zoom === 100;
    $('zoom').textContent = zoom + '%';
    const marked = Boolean(t && t.url && library.bookmarks.some((b) => b.url === t.url));
    $('bookmark').disabled = !(t && t.url);
    $('bookmark').textContent = marked ? '★' : '☆';
    $('bookmark').setAttribute('aria-pressed', String(marked));
    $('bookmark').title = marked ? '移除书签 (⌘D)' : '加入书签 (⌘D)';
    // 新标签页上没有网页可查找
    if (findOpen && !(t && t.url)) setFind(false);
    refreshSite();
  }

  const isTape = (u) => /^tape:\/\//i.test(u || '');
  const shortHex = (h) => (h && h.length > 20 ? h.slice(0, 10) + '…' + h.slice(-8) : h || '—');
  const SOURCE = { chain: '从链上下载', cache: '链上哈希未变，使用本机缓存', stale: '读链失败，显示的是上次缓存的版本' };

  /** 标签网址或加载状态变化时重新读取网站信息 */
  function refreshSite() {
    const t = active();
    const tape = Boolean(t && isTape(t.url));
    $('site-btn').hidden = !tape;
    if (!tape) { siteInfo = null; siteKey = ''; if (siteOpen) setSite(false); return; }
    const key = `${t.id}|${t.url}|${t.loading}`;
    if (key === siteKey || t.loading) return;
    siteKey = key;
    tb.invoke('siteInfo').then((info) => {
      if (siteKey !== key) return;
      siteInfo = info;
      renderSite();
    }).catch(() => {});
  }

  function siteState(info) {
    if (!info || info.error) return { cls: 'bad', text: '读取失败' };
    if (!info.exists) return { cls: 'bad', text: '电路不存在' };
    if (!info.opened) return { cls: 'bad', text: '未开通容器' };
    if (!info.file) return { cls: 'bad', text: '文件不存在' };
    if (info.stale || info.file.source === 'stale') return { cls: 'stale', text: '离线缓存' };
    return { cls: 'ok', text: '链上 · 已校验' };
  }

  function renderSite() {
    const st = siteState(siteInfo);
    const b = $('site-btn');
    b.className = st.cls === 'ok' ? '' : st.cls;
    b.textContent = st.cls === 'ok' ? '链上' : st.text;
    b.title = '网站信息：' + st.text;
    if (!siteOpen) return;
    const info = siteInfo || {};
    $('si-label').textContent = info.label || '网站信息';
    $('si-status').textContent = st.text;
    $('si-status').className = st.cls;
    const dl = $('si-list');
    dl.textContent = '';
    const row = (name, value, copy) => {
      const dd = document.createElement('dd');
      dd.append(Object.assign(document.createElement('span'), { className: 'v', textContent: value ?? '—', title: copy || value || '' }));
      if (copy) {
        const c = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: '复制' });
        c.addEventListener('click', () => tb.invoke('copy', copy).then(() => { c.textContent = '已复制'; setTimeout(() => { c.textContent = '复制'; }, 1200); }));
        dd.append(c);
      }
      dl.append(Object.assign(document.createElement('dt'), { textContent: name }), dd);
    };
    if (info.error) { row('错误', info.error); return; }
    row('链', info.network || 'BNB Chain');
    row('电路', `#${info.tokenId}，处理器 ${info.cpu}${info.area ? `（区号 ${info.area}）` : ''}`);
    row('持有人', shortHex(info.owner), info.owner);
    row('容器', shortHex(info.container), info.container);
    row('电路合约', shortHex(info.circuits), info.circuits);
    row('当前文件', '/' + (info.path || ''));
    if (info.file) {
      row('SHA-256', shortHex(info.file.sha256), info.file.sha256);
      row('大小', info.file.size >= 1024 ? (info.file.size / 1024).toFixed(1) + ' KB' : info.file.size + ' 字节');
      row('上链时间', info.file.updatedAt ? new Date(info.file.updatedAt * 1000).toLocaleString() : '—');
      row('读取方式', SOURCE[info.file.source] || info.file.source);
    }
  }

  function setSite(on) {
    siteOpen = on;
    $('siteinfo').hidden = !on;
    $('site-btn').setAttribute('aria-expanded', String(on));
    if (on) {
      // 打开面板时重新读一次，显示最新状态
      siteKey = '';
      renderSite();
      refreshSite();
    }
  }


  /** 书签和最近访问列表 */
  function renderLibrary() {
    const fill = (ul, items, onRemove, removeLabel) => {
      ul.textContent = '';
      for (const it of items) {
        const li = document.createElement('li');
        const a = Object.assign(document.createElement('a'), { href: it.url, title: it.url });
        a.append(
          Object.assign(document.createElement('span'), { className: 't', textContent: it.title || it.label || it.url }),
          Object.assign(document.createElement('span'), { className: 'u', textContent: it.label || it.url }),
        );
        // ⌘ 点击或中键在后台标签打开
        a.addEventListener('click', (e) => { e.preventDefault(); tb.invoke('openUrl', it.url, { background: e.metaKey || e.ctrlKey }); });
        a.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); tb.invoke('openUrl', it.url, { background: true }); } });
        const rm = Object.assign(document.createElement('button'), { type: 'button', className: 'remove', textContent: '×', title: removeLabel });
        rm.setAttribute('aria-label', removeLabel + ' ' + (it.title || it.url));
        rm.addEventListener('click', () => onRemove(it.url));
        li.append(a, rm);
        ul.append(li);
      }
    };
    fill($('bookmarks'), library.bookmarks, (u) => tb.invoke('removeBookmark', u), '移除书签');
    fill($('history'), library.history.slice(0, 30), (u) => tb.invoke('removeHistory', u), '从最近访问中删除');
    $('bookmarks-empty').hidden = library.bookmarks.length > 0;
    $('history-empty').hidden = library.history.length > 0;
    $('clear-history').hidden = !library.history.length;
    renderPanels();
  }

  function renderPanels() {
    const cur = panel || (library.history.length ? 'history' : 'directory');
    for (const b of document.querySelectorAll('#lib-tabs [role="tab"]')) {
      const on = b.dataset.panel === cur;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('panel-' + b.dataset.panel).hidden = !on;
    }
  }

  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  };
  const day = (sec) => {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /** 状态行：各链的进度或错误，扫完后显示总数和各链数量 */
  function dirStatusText(st) {
    const nets = st.networks || [];
    const LABEL = { cpus: '读取处理器', opened: '检查容器开通', index: '读取首页', check: '检查更新', titles: '读取网站标题' };
    const busy = nets.filter((n) => n.progress && n.progress.stage !== 'error');
    const bad = nets.filter((n) => n.progress && n.progress.stage === 'error');
    const parts = busy.map((n) => {
      const p = n.progress;
      return `${n.name} 正在${LABEL[p.stage] || '刷新'}${p.total ? `（${p.done} / ${p.total}）` : ''}`;
    });
    for (const n of bad) parts.push(`${n.name} 刷新失败：${n.progress.message}`);
    if (parts.length) return parts.join(' · ') + (busy.length ? '…' : '');
    if (!st.lastFullScan) return '还没有扫描过，第一次扫描大约需要三分钟。';
    const per = nets.filter((n) => n.count).map((n) => `${NET_SHORT[n.key] || n.name} ${n.count}`).join('，');
    return `已收录 ${st.count} 个网站${per ? `（${per}）` : ''} · ${ago(st.lastFullScan)}更新`;
  }

  /** 全部网站：按搜索词过滤、排序，只渲染前 dirLimit 条 */
  function renderDirectory() {
    const st = dir.status;
    $('dir-count').textContent = st.count ? String(st.count) : '';
    $('dir-status').textContent = dirStatusText(st);
    $('dir-refresh').hidden = Boolean(st.running);
    const q = $('dir-search').value.trim().toLowerCase();
    const netFilter = $('dir-net').value;
    let items = netFilter ? dir.sites.filter((s) => (s.network || 'bnb') === netFilter) : dir.sites;
    if (q) {
      items = items.filter((s) => (s.title || '').toLowerCase().includes(q)
        || s.label.toLowerCase().includes(q)
        || s.label.replace(/\.tape$/, '') === q.replace(/^#/, '').replace(/\.tape$/, '')
        || String(s.tokenId) === q.replace(/^#/, '')
        || (s.owner || '').toLowerCase().includes(q));
    }
    const sort = $('dir-sort').value;
    items = items.slice().sort(sort === 'id' ? (a, b) => a.tokenId - b.tokenId || a.cpu - b.cpu
      : sort === 'cpu' ? (a, b) => (a.area || 0) - (b.area || 0) || a.cpu - b.cpu || a.tokenId - b.tokenId
        : (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.tokenId - b.tokenId);
    const ul = $('directory');
    ul.textContent = '';
    for (const it of items.slice(0, dirLimit)) {
      const li = document.createElement('li');
      // 标题来自网站自己的 HTML，只用 textContent
      const a = Object.assign(document.createElement('a'), { href: it.url, title: `${it.url}\n持有人 ${it.owner}` });
      a.append(
        Object.assign(document.createElement('span'), { className: 't' + (it.title ? '' : ' untitled'), textContent: it.title || '（没有标题）' }),
        Object.assign(document.createElement('span'), { className: 'net ' + (it.network || 'bnb'), textContent: NET_SHORT[it.network || 'bnb'] }),
        Object.assign(document.createElement('span'), { className: 'u', textContent: it.label }),
        Object.assign(document.createElement('span'), { className: 'd', textContent: day(it.updatedAt) }),
      );
      a.addEventListener('click', (e) => { e.preventDefault(); tb.invoke('openUrl', it.url, { background: e.metaKey || e.ctrlKey }); });
      a.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); tb.invoke('openUrl', it.url, { background: true }); } });
      li.append(a);
      ul.append(li);
    }
    $('dir-more').hidden = items.length <= dirLimit;
    $('dir-more').textContent = `显示更多（还有 ${items.length - dirLimit} 个）`;
  }

  function setFind(on) {
    findOpen = on;
    $('findbar').hidden = !on;
    if (on) {
      $('find-input').focus();
      $('find-input').select();
      if ($('find-input').value) runFind(false);
    } else {
      $('find-count').textContent = '';
      $('find-input').classList.remove('none');
      tb.invoke('stopFind');
    }
  }

  function runFind(again, forward = true) {
    const text = $('find-input').value;
    if (!text) { $('find-count').textContent = ''; $('find-input').classList.remove('none'); tb.invoke('stopFind'); return; }
    tb.invoke('find', text, { again, forward });
  }

  const chainName = (id) => (id ? CHAINS[id] || '链 ' + parseInt(id, 16) : '未知链');

  function renderWallet() {
    const b = $('wallet');
    b.className = '';
    if (wallet.ready && wallet.account) {
      // 当前网站所在的链和钱包的链不一致时提醒（签名、交易会发到钱包当前的链上）
      const want = tabChain(active());
      const wrongChain = Boolean(wallet.chainId && (want ? wallet.chainId !== want : !CHAINS[wallet.chainId]));
      b.textContent = (wrongChain ? '⚠ ' : '') + wallet.account.slice(0, 6) + '…' + wallet.account.slice(-4);
      b.title = (wallet.wallet || '钱包') + '：' + chainName(wallet.chainId)
        + (wrongChain ? (want ? `，这个网站在 ${CHAINS[want]} 上，请在钱包里切换` : '，不是 TapeKit 支持的链') : '');
      b.classList.add(wrongChain ? 'warn' : 'ready');
    } else if (wallet.connected) {
      b.textContent = '在浏览器里选择钱包…';
      b.title = '桥接页面已打开，请在页面里选择钱包';
    } else {
      b.textContent = '连接钱包';
      b.title = '在系统浏览器里打开钱包桥接页面';
    }
    const s = $('wallet-status');
    if (wallet.ready && wallet.account) s.textContent = `${wallet.wallet || '钱包'} · ${wallet.account} · ${chainName(wallet.chainId)}`;
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
    renderRpcs(s.networks);
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
    const u = await tb.invoke('cacheUsage');
    $('cache-usage').textContent = `已缓存 ${u.files} 个文件，共 ${(u.bytes / 1024 / 1024).toFixed(1)} MB`;
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
  /** 每条链一个节点输入框，各自保存 */
  function renderRpcs(networks) {
    const box = $('rpc-nets');
    box.textContent = '';
    for (const n of networks) {
      const sec = Object.assign(document.createElement('section'), { className: 'rpc-net' });
      const ta = Object.assign(document.createElement('textarea'), { rows: 4, spellcheck: false, value: n.rpcUrls.join('\n'), placeholder: n.defaultRpcs.join('\n') });
      ta.setAttribute('aria-label', n.name + ' RPC 节点');
      const msg = Object.assign(document.createElement('span'), { className: 'muted' });
      msg.setAttribute('role', 'status');
      const save = Object.assign(document.createElement('button'), { type: 'button', textContent: '保存' });
      save.addEventListener('click', async () => {
        const list = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
        try { await tb.invoke('saveRpcs', n.key, list); msg.textContent = list.length ? '已保存' : '已恢复内置节点'; } catch (e) { msg.textContent = errText(e); }
      });
      const actions = Object.assign(document.createElement('div'), { className: 'actions' });
      actions.append(save, msg);
      sec.append(Object.assign(document.createElement('h3'), { textContent: n.name }), ta, actions);
      box.append(sec);
    }
  }
  for (const b of document.querySelectorAll('.examples button')) {
    b.addEventListener('click', () => { $('address').value = b.dataset.q; tb.invoke('submit', b.dataset.q); });
  }

  function focusAddress() {
    setTimeout(() => { $('address').focus(); $('address').select(); }, 0);
  }

  tb.on('tabs', (s) => {
    const switched = s.activeId !== state.activeId;
    state = s;
    renderTabs();
    renderNav();
    // 钱包按钮的「链不对」提醒取决于当前标签
    renderWallet();
    // 主进程切换标签时会结束旧标签的查找，在新标签上重新查找
    if (switched && findOpen) runFind(false);
  });
  tb.on('wallet', (w) => { wallet = w || {}; renderWallet(); });
  tb.on('notice', (n) => notice(n.text, n.level));
  tb.on('command', (name) => {
    if (name === 'focusAddress') focusAddress();
    else if (name === 'settings') setSettings(!settingsOpen);
    else if (name === 'find') { if (active() && active().url) setFind(true); }
    else if (name === 'findNext' || name === 'findPrev') {
      if (!findOpen) { if (active() && active().url) setFind(true); return; }
      runFind(true, name === 'findNext');
    }
  });
  tb.on('library', (l) => { library = l || { history: [], bookmarks: [] }; renderLibrary(); renderNav(); });
  tb.on('directory', (sites) => { dir.sites = sites || []; renderDirectory(); });
  tb.on('directoryStatus', (st) => { dir.status = st || dir.status; renderDirectory(); });
  tb.invoke('directory').then((d) => { dir = d; renderDirectory(); }).catch(() => {});
  renderPanels();
  for (const b of document.querySelectorAll('#lib-tabs [role="tab"]')) {
    b.addEventListener('click', () => { panel = b.dataset.panel; renderPanels(); });
  }
  // 左右方向键在分栏之间切换
  $('lib-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...document.querySelectorAll('#lib-tabs [role="tab"]')];
    const i = all.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    panel = next.dataset.panel;
    renderPanels();
    next.focus();
  });
  $('dir-search').addEventListener('input', () => { dirLimit = 200; renderDirectory(); });
  $('dir-sort').addEventListener('change', () => { dirLimit = 200; renderDirectory(); });
  $('dir-net').addEventListener('change', () => { dirLimit = 200; renderDirectory(); });
  $('dir-more').addEventListener('click', () => { dirLimit += 200; renderDirectory(); });
  $('dir-refresh').addEventListener('click', async () => {
    try { dir.status = await tb.invoke('scanDirectory'); renderDirectory(); } catch (e) { notice(errText(e), 'error'); }
  });
  tb.on('findResult', (r) => {
    if (!findOpen) return;
    $('find-count').textContent = r.matches ? `${r.active} / ${r.matches}` : '无结果';
    $('find-input').classList.toggle('none', !r.matches);
  });

  $('find-input').addEventListener('input', () => runFind(false));
  // Enter 下一个，Shift+Enter 上一个，Esc 关闭
  $('find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); setFind(false); }
    else if (e.key === 'Enter') { e.preventDefault(); runFind(true, !e.shiftKey); }
  });
  $('findbar').addEventListener('submit', (e) => e.preventDefault());
  $('find-next').addEventListener('click', () => runFind(true, true));
  $('find-prev').addEventListener('click', () => runFind(true, false));
  $('find-close').addEventListener('click', () => setFind(false));
  $('zoom').addEventListener('click', () => tb.invoke('zoom', 0));
  $('bookmark').addEventListener('click', () => tb.invoke('toggleBookmark'));
  $('clear-history').addEventListener('click', () => tb.invoke('clearHistory'));
  $('site-btn').addEventListener('click', () => setSite(!siteOpen));
  $('si-close').addEventListener('click', () => setSite(false));
  $('clear-cache').addEventListener('click', async () => { await tb.invoke('clearCache'); loadSettings(); });

  renderWallet();
  renderNav();
  tb.invoke('ready');
  reportBounds();
})();
