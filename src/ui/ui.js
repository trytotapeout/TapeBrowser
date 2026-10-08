// 浏览器外壳界面：标签栏、地址栏、新标签页、设置。网页内容由主进程的 WebContentsView 叠在 #content 区域。
'use strict';
(function () {
  const tb = window.tb;
  // 界面文字：中文是 key，英文界面查 tb.en，没有翻译的原样显示；{name} 是占位符
  const EN = tb.lang === 'en' ? tb.en || {} : null;
  const tr = (text, vars) => {
    let s = (EN && EN[text]) ?? text;
    if (vars) s = s.replace(/\{(\w+)\}/g, (all, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : all));
    return s;
  };
  /** 翻译 index.html 里写死的中文：文字节点和 title / aria-label / placeholder */
  function localize(root) {
    document.documentElement.lang = tb.lang === 'en' ? 'en' : 'zh';
    if (!EN) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const raw = n.nodeValue;
      const key = raw.trim();
      if (key && EN[key]) n.nodeValue = raw.replace(key, EN[key]);
    }
    for (const el of root.querySelectorAll('[title], [aria-label], [placeholder]')) {
      for (const a of ['title', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v && EN[v]) el.setAttribute(a, EN[v]);
      }
    }
  }
  localize(document.body);
  const $ = (id) => document.getElementById(id);
  let state = { tabs: [], activeId: null };
  let wallet = {};
  // 钱包的 BEM 价格和余额（bem.js 的 view）
  let bemView = null;
  let library = { history: [], bookmarks: [] };
  let dir = { sites: [], status: { count: 0, lastFullScan: 0, running: false, progress: null } };
  // 用户手动选过的分栏；没选过时有最近访问就显示最近访问，否则显示全部网站
  let panel = null;
  let dirLimit = 200;
  let findOpen = false;
  let siteOpen = false;
  let siteInfo = null;
  // 当前页面的多节点交叉校验结果 {url, status, nodes, mismatches}
  let verify = null;
  // 当前网站容器里的资产 {url, assets} | {url, error}；打开网站信息面板时读一次
  let assets = null;
  // 「持有的全部网站」：下一次显示新标签页时按这个持有人筛选
  let pendingOwner = null;
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
  // 简称：BNB Chain 写成 BSC，免得和 BNB 币的数量混在一起
  const NET_SHORT = { bnb: 'BSC', xlayer: 'X Layer', base: 'Base' };
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
      const close = Object.assign(document.createElement('button'), { className: 'close', type: 'button', textContent: '×', title: tr('关闭标签页') });
      close.setAttribute('aria-label', tr('关闭标签页 ') + t.title);
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
    $('reload').title = t && t.loading ? tr('停止') : tr('重新加载');
    if (!editing) $('address').value = t && t.url ? t.url : '';
    document.title = t ? t.title + ' - TapeBrowser' : 'TapeBrowser';
    $('newtab-page').hidden = settingsOpen || Boolean(t && t.url);
    if (pendingOwner && t && !t.url) {
      $('dir-search').value = pendingOwner;
      $('dir-net').value = '';
      pendingOwner = null;
      panel = 'directory';
      dirLimit = 200;
      renderPanels();
      renderDirectory();
    }
    $('settings-page').hidden = !settingsOpen;
    const zoom = t ? t.zoom : 100;
    // 新标签页画在外壳界面里，只缩放这一块，标签栏和地址栏不变
    $('newtab-page').style.zoom = t && !t.url && zoom !== 100 ? String(zoom / 100) : '';
    $('zoom').hidden = zoom === 100;
    $('zoom').textContent = zoom + '%';
    const marked = Boolean(t && t.url && library.bookmarks.some((b) => b.url === t.url));
    $('bookmark').disabled = !(t && t.url);
    $('bookmark').textContent = marked ? '★' : '☆';
    $('bookmark').setAttribute('aria-pressed', String(marked));
    $('bookmark').title = marked ? tr('移除书签 (⌘D)') : tr('加入书签 (⌘D)');
    // 新标签页上没有网页可查找
    if (findOpen && !(t && t.url)) setFind(false);
    refreshSite();
  }

  const isTape = (u) => /^tape:\/\//i.test(u || '');
  const shortHex = (h) => (h && h.length > 20 ? h.slice(0, 10) + '…' + h.slice(-8) : h || '—');
  const SOURCE = { chain: tr('从链上下载'), cache: tr('链上哈希未变，使用本机缓存'), stale: tr('读链失败，显示的是上次缓存的版本') };

  /** 标签网址或加载状态变化时重新读取网站信息 */
  function refreshSite() {
    const t = active();
    const tape = Boolean(t && isTape(t.url));
    $('site-btn').hidden = !tape;
    // 网站所在的链：直接从网址的区号判断，不用等读链
    const chain = tape ? tabChain(t) : null;
    const tag = $('chain-tag');
    tag.hidden = !chain;
    if (chain) {
      tag.textContent = CHAINS[chain];
      tag.dataset.chain = chain;
      tag.title = tr('这个网站在 ') + CHAINS[chain] + tr(' 上');
      tag.setAttribute('aria-label', tr('所在的链：') + CHAINS[chain]);
    }
    if (!tape) { siteInfo = null; verify = null; siteKey = ''; if (siteOpen) setSite(false); return; }
    const key = `${t.id}|${t.url}|${t.loading}`;
    if (key === siteKey || t.loading) return;
    siteKey = key;
    if (verify && verify.url !== t.url) verify = null;
    tb.invoke('siteInfo').then((info) => {
      if (siteKey !== key) return;
      siteInfo = info;
      renderSite();
      // 页面读完后再让另外两个节点交叉校验，不拖慢打开网页
      return tb.invoke('verifySite').then((v) => {
        if (siteKey !== key) return;
        verify = v;
        renderSite();
      });
    }).catch(() => {});
  }

  function siteState(info) {
    if (!info || info.error) return { cls: 'bad', text: tr('读取失败') };
    if (!info.exists) return { cls: 'bad', text: tr('电路不存在') };
    if (!info.opened) return { cls: 'bad', text: tr('未开通容器') };
    if (!info.file) return { cls: 'bad', text: tr('文件不存在') };
    if (info.stale || info.file.source === 'stale') return { cls: 'stale', text: tr('离线缓存') };
    if (verify && verify.status === 'mismatch') return { cls: 'bad', text: tr('节点结果不一致') };
    // 外部脚本、接口不在链上，不受校验保护
    if ((info.external || []).some((e) => e.risky)) return { cls: 'stale', text: tr('含外部脚本') };
    return { cls: 'ok', text: tr('链上 · 已校验') };
  }

  function renderSite() {
    const st = siteState(siteInfo);
    const b = $('site-btn');
    b.className = st.cls === 'ok' ? '' : st.cls;
    b.textContent = st.cls === 'ok' ? tr('链上') : st.text;
    b.title = tr('网站信息：') + st.text;
    if (!siteOpen) return;
    const info = siteInfo || {};
    $('si-label').textContent = info.label || tr('网站信息');
    $('si-status').textContent = st.text;
    $('si-status').className = st.cls;
    const dl = $('si-list');
    dl.textContent = '';
    const row = (name, value, copy) => {
      const dd = document.createElement('dd');
      dd.append(Object.assign(document.createElement('span'), { className: 'v', textContent: value ?? '—', title: copy || value || '' }));
      if (copy) {
        const c = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: tr('复制') });
        c.addEventListener('click', () => tb.invoke('copy', copy).then(() => { c.textContent = tr('已复制'); setTimeout(() => { c.textContent = tr('复制'); }, 1200); }));
        dd.append(c);
      }
      dl.append(Object.assign(document.createElement('dt'), { textContent: name }), dd);
      return dd;
    };
    if (info.error) { row(tr('错误'), info.error); return; }
    row(tr('链'), info.network || 'BNB Chain');
    row(tr('电路'), tr('#{tokenId}，处理器 {cpu}{0}', { tokenId: info.tokenId, cpu: info.cpu, 0: info.area ? tr('（区号 {area}）', { area: info.area }) : '' }));
    row(tr('持有人'), shortHex(info.owner), info.owner);
    if (info.owner) ownerLink(info.owner);
    const seen = info.seen || {};
    if (seen.prevOwner) row(tr('上一任持有人'), shortHex(seen.prevOwner) + (seen.ownerChangedAt ? tr('（{0}发现变更）', { 0: ago(seen.ownerChangedAt) }) : ''), seen.prevOwner);
    row(tr('容器'), shortHex(info.container), info.container);
    if (info.container) row(tr('容器资产'), assetsText());
    row(tr('电路合约'), shortHex(info.circuits), info.circuits);
    row(tr('当前文件'), '/' + (info.path || ''));
    if (info.file) {
      row('SHA-256', shortHex(info.file.sha256), info.file.sha256);
      row(tr('大小'), info.file.size >= 1024 ? (info.file.size / 1024).toFixed(1) + ' KB' : info.file.size + tr(' 字节'));
      row(tr('上链时间'), info.file.updatedAt ? new Date(info.file.updatedAt * 1000).toLocaleString() : '—');
      row(tr('读取方式'), SOURCE[info.file.source] || info.file.source);
    }
    row(tr('交叉校验'), verifyText());
    row(tr('外部资源'), externalText(info.external || []));
    if (info.container && info.opened) tipRow(row, info);
  }

  /** 容器里的原生币和 BEM：数额按精度显示，小数最多 4 位 */
  function assetsText() {
    const t = active();
    if (!assets || assets.url !== (t && t.url)) return tr('读取中…');
    if (assets.error) return tr('读取失败：{message}', { message: assets.error });
    return assets.assets.map((a) => (a.error ? tr('{symbol} 读取失败', { symbol: a.symbol }) : `${units(a.amount, a.decimals)} ${a.symbol}`)).join(tr('，'));
  }

  const units = (raw, decimals) => {
    const v = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const frac = (v % base).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
    const whole = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${whole}.${frac}` : whole;
  };

  /** 打开网站信息面板时读一次容器资产 */
  function loadAssets() {
    const t = active();
    const url = t && t.url;
    if (!url || !isTape(url)) return;
    assets = null;
    tb.invoke('siteAssets').then((r) => {
      if (!r || r.url !== url) return;
      assets = r;
      if (siteOpen) renderSite();
    }).catch(() => {});
  }

  /** 打赏一行的来源说明：钱包在这条链上的 BEM */
  function tipSource(netKey, name) {
    const here = bemView && bemView.balance && bemView.balance.networks.find((n) => n.key === netKey);
    return tr('从你的钱包（{name} 上 {amount} BEM）', { name: name || 'BNB Chain', amount: here && here.balance !== null ? here.balance : '…' });
  }

  /** 打赏一行：用当前钱包把 BEM 转进网站的容器 */
  function tipRow(row, info) {
    const netKey = { 'BNB Chain': 'bnb', 'X Layer': 'xlayer', Base: 'base' }[info.network || 'BNB Chain'];
    if (!wallet.ready) { row(tr('打赏'), tr('连接钱包后可以打赏 BEM 给这个网站')); return; }
    const bal = bemView && bemView.balance;
    if (bal && !bal.networks.some((n) => n.key === netKey)) { row(tr('打赏'), tr('{name} 上没有 BEM，不能打赏', { name: info.network })); return; }
    const dd = row(tr('打赏'), tipSource(netKey, info.network));
    dd.firstChild.dataset.tipNet = netKey;
    const input = Object.assign(document.createElement('input'), { type: 'text', inputMode: 'decimal', value: '0.01', className: 'tip-amount', spellcheck: false });
    input.setAttribute('aria-label', tr('打赏数额（BEM）'));
    const go = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: tr('打赏 BEM') });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const r = await tb.invoke('tip', input.value);
        if (r && r.ok) input.value = '0.01';
      } catch (e) { notice(errText(e), 'error'); }
      go.disabled = false;
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    dd.append(input, go);
  }

  /** 不在链上的外部资源：脚本、接口能改变网页行为，不受链上校验保护 */
  function externalText(list) {
    if (!list.length) return tr('没有，全部内容来自链上');
    const risky = list.filter((e) => e.risky);
    const show = (arr) => arr.slice(0, 4).map((e) => e.origin.replace(/^https?:\/\//, '')).join(tr('、')) + (arr.length > 4 ? tr(' 等 {n} 个', { n: arr.length }) : '');
    if (risky.length) return tr('运行了外部脚本或接口，不受链上校验保护：{list}', { list: show(risky) });
    return tr('只加载了外部图片、字体或样式：{list}', { list: show(list) });
  }

  /** 多节点交叉校验的说明 */
  function verifyText() {
    const v = verify;
    if (!v) return tr('正在向另外两个节点核对…');
    if (v.status === 'ok') return tr('{0} 读到的容器和文件哈希一致', { 0: v.nodes.join(tr('、')) });
    if (v.status === 'single') return v.nodes.length ? tr('只有 {0} 可用，没有第二个节点可以核对', { 0: v.nodes[0] }) : tr('没有其他可用节点，无法核对');
    if (v.status === 'skip') return tr('这个页面不是从链上读到的，不核对');
    if (v.status === 'error') return tr('核对失败：') + v.message;
    const what = { container: tr('容器地址'), sha256: tr('文件哈希') };
    return tr('不一致：') + v.mismatches.map((m) => tr('{node} 读到的{0}是 {1}', { node: m.node, 0: what[m.field], 1: shortHex(m.got) || tr('空') })).join(tr('；'))
      + tr('。可能是节点数据有问题，或网站刚好在更新，请刷新后再看；签名、交易前请核对。');
  }

  /** 持有人一行后面加「持有的全部网站」：在新标签页的全部网站里按持有人筛选 */
  function ownerLink(owner) {
    const dd = $('si-list').lastElementChild;
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: tr('持有的全部网站') });
    b.title = tr('在全部网站里查看这个地址持有的网站');
    b.addEventListener('click', () => showOwner(owner));
    dd.append(b);
  }

  /** 打开新标签页，全部网站按持有人筛选 */
  function showOwner(owner) {
    pendingOwner = owner.toLowerCase();
    setSite(false);
    tb.invoke('newTab');
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
      loadAssets();
    }
  }


  /** 书签和最近访问列表 */
  function renderLibrary() {
    const fill = (ul, items, onRemove, removeLabel) => {
      ul.textContent = '';
      for (const it of items) {
        const li = document.createElement('li');
        const a = Object.assign(document.createElement('a'), { href: it.url, title: it.url });
        a.append(Object.assign(document.createElement('span'), { className: 't', textContent: it.title || it.label || it.url }));
        // 上次访问之后首页更新了 / 持有人变了
        if (it.ownerChange) {
          const b = Object.assign(document.createElement('span'), { className: 'badge warn', textContent: tr('持有人已变') });
          b.title = tr('持有人 {from} → {to}', { from: it.ownerChange.from, to: it.ownerChange.to });
          a.append(b);
        } else if (it.updated) {
          a.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: tr('有更新'), title: tr('上次访问之后首页更新了') }));
        }
        a.append(Object.assign(document.createElement('span'), { className: 'u', textContent: it.label || it.url }));
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
    fill($('bookmarks'), library.bookmarks, (u) => tb.invoke('removeBookmark', u), tr('移除书签'));
    fill($('history'), library.history.slice(0, 30), (u) => tb.invoke('removeHistory', u), tr('从最近访问中删除'));
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
    if (s < 60) return tr('刚刚');
    if (s < 3600) return Math.floor(s / 60) + tr(' 分钟前');
    if (s < 86400) return Math.floor(s / 3600) + tr(' 小时前');
    return Math.floor(s / 86400) + tr(' 天前');
  };
  const day = (sec) => {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /** 状态行：各链的进度或错误，扫完后显示总数和各链数量 */
  function dirStatusText(st) {
    const nets = st.networks || [];
    const LABEL = { cpus: tr('读取处理器'), opened: tr('检查容器开通'), index: tr('读取首页'), check: tr('检查更新'), titles: tr('读取网站标题') };
    const busy = nets.filter((n) => n.progress && n.progress.stage !== 'error');
    const bad = nets.filter((n) => n.progress && n.progress.stage === 'error');
    const parts = busy.map((n) => {
      const p = n.progress;
      return tr('{name} 正在{0}{1}', { name: n.name, 0: LABEL[p.stage] || tr('刷新'), 1: p.total ? tr('（{done} / {total}）', { done: p.done, total: p.total }) : '' });
    });
    for (const n of bad) parts.push(tr('{name} 刷新失败：{message}', { name: n.name, message: n.progress.message }));
    if (parts.length) return parts.join(' · ') + (busy.length ? '…' : '');
    if (!st.lastFullScan) return tr('还没有扫描过，第一次扫描大约需要三分钟。');
    const per = nets.filter((n) => n.count).map((n) => `${NET_SHORT[n.key] || n.name} ${n.count}`).join(tr('，'));
    return tr('已收录 {count} 个网站{0} · {1}更新', { count: st.count, 0: per ? tr('（{per}）', { per }) : '', 1: ago(st.lastUpdate || st.lastFullScan) });
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
    for (const it of items.slice(0, dirLimit)) ul.append(dirItem(it, it.updatedAt));
    $('dir-more').hidden = items.length <= dirLimit;
    $('dir-more').textContent = tr('显示更多（还有 {0} 个）', { 0: items.length - dirLimit });
    renderNewSites();
  }

  /** 目录里的一行；date 是右边显示的上链时间（秒） */
  function dirItem(it, date) {
    const li = document.createElement('li');
    // 标题来自网站自己的 HTML，只用 textContent
    const a = Object.assign(document.createElement('a'), { href: it.url, title: tr('{url}\n持有人 {owner}', { url: it.url, owner: it.owner }) });
    a.append(
      Object.assign(document.createElement('span'), { className: 't' + (it.title ? '' : ' untitled'), textContent: it.title || tr('（没有标题）') }),
      Object.assign(document.createElement('span'), { className: 'net ' + (it.network || 'bnb'), textContent: NET_SHORT[it.network || 'bnb'] }),
      Object.assign(document.createElement('span'), { className: 'u', textContent: it.label }),
      Object.assign(document.createElement('span'), { className: 'd', textContent: day(date) }),
    );
    a.addEventListener('click', (e) => { e.preventDefault(); tb.invoke('openUrl', it.url, { background: e.metaKey || e.ctrlKey }); });
    a.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); tb.invoke('openUrl', it.url, { background: true }); } });
    li.append(a);
    return li;
  }

  /** 新上线：首页最早的上链时间在最近 7 天内的网站，最新的在前 */
  const NEW_DAYS = 7;
  function renderNewSites() {
    const since = Date.now() / 1000 - NEW_DAYS * 86400;
    const pub = (it) => it.firstPublished || it.updatedAt || 0;
    const items = dir.sites.filter((it) => pub(it) >= since).sort((a, b) => pub(b) - pub(a));
    const ul = $('newsites');
    ul.textContent = '';
    for (const it of items.slice(0, 100)) ul.append(dirItem(it, pub(it)));
    $('newsites-empty').hidden = items.length > 0;
    $('tab-new').textContent = tr('新上线');
    if (items.length) $('tab-new').append(' ', Object.assign(document.createElement('span'), { className: 'muted', textContent: String(items.length) }));
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

  const chainName = (id) => (id ? CHAINS[id] || tr('链 ') + parseInt(id, 16) : tr('未知链'));

  function renderWallet() {
    const b = $('wallet');
    b.className = '';
    if (wallet.ready && wallet.account) {
      // 当前网站所在的链和钱包的链不一致时提醒（签名、交易会发到钱包当前的链上）
      const want = tabChain(active());
      const wrongChain = Boolean(wallet.chainId && (want ? wallet.chainId !== want : !CHAINS[wallet.chainId]));
      b.textContent = (wrongChain ? '⚠ ' : '') + wallet.account.slice(0, 6) + '…' + wallet.account.slice(-4);
      b.title = (wallet.wallet || tr('钱包')) + tr('：') + chainName(wallet.chainId)
        + (wrongChain ? (want ? tr('，这个网站在 {0} 上，点击切换', { 0: CHAINS[want] }) : tr('，不是 TapeKit 支持的链')) : '');
      b.classList.add(wrongChain ? 'warn' : 'ready');
    } else if (wallet.connected) {
      b.textContent = tr('在浏览器里选择钱包…');
      b.title = tr('桥接页面已打开，请在页面里选择钱包');
    } else {
      b.textContent = tr('连接钱包');
      b.title = tr('在系统浏览器里打开钱包桥接页面');
    }
    const s = $('wallet-status');
    if (wallet.ready && wallet.account) s.textContent = `${wallet.wallet || tr('钱包')} · ${wallet.account} · ${chainName(wallet.chainId)}`;
    else if (wallet.connected) s.textContent = tr('桥接页面已打开，还没有选择钱包。');
    else s.textContent = tr('没有连接钱包。');
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
    $('lang').value = s.lang;
    const ul = $('origins');
    ul.textContent = '';
    if (!s.origins.length) ul.append(Object.assign(document.createElement('li'), { className: 'muted', textContent: tr('还没有网站连接过钱包。') }));
    for (const o of s.origins) {
      const li = document.createElement('li');
      li.append(Object.assign(document.createElement('span'), { textContent: o.name === o.origin ? o.origin : tr('{name}（{origin}）', { name: o.name, origin: o.origin }) }));
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: tr('取消授权') });
      b.addEventListener('click', async () => { await tb.invoke('revoke', o.origin); loadSettings(); });
      li.append(b);
      ul.append(li);
    }
    renderWallet();
    const u = await tb.invoke('cacheUsage');
    $('cache-usage').textContent = tr('已缓存 {files} 个文件，共 {0} MB', { files: u.files, 0: (u.bytes / 1024 / 1024).toFixed(1) });
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
  // 点 BEM 按钮刷新价格和余额
  $('bem').addEventListener('click', () => tb.invoke('refreshBem'));
  $('wallet').addEventListener('click', () => {
    if (!wallet.ready) { tb.invoke('openBridge'); return; }
    // 红色（链不对）时直接请钱包切到当前网站所在的链
    if ($('wallet').classList.contains('warn') && tabChain(active())) { tb.invoke('switchChain'); return; }
    setSettings(true);
  });
  $('open-bridge').addEventListener('click', () => tb.invoke('openBridge'));
  $('disconnect-wallet').addEventListener('click', () => tb.invoke('disconnectWallet'));
  /** 每条链一个节点输入框，各自保存 */
  function renderRpcs(networks) {
    const box = $('rpc-nets');
    box.textContent = '';
    for (const n of networks) {
      const sec = Object.assign(document.createElement('section'), { className: 'rpc-net' });
      const ta = Object.assign(document.createElement('textarea'), { rows: 4, spellcheck: false, value: n.rpcUrls.join('\n'), placeholder: n.defaultRpcs.join('\n') });
      ta.setAttribute('aria-label', n.name + tr(' RPC 节点'));
      const msg = Object.assign(document.createElement('span'), { className: 'muted' });
      msg.setAttribute('role', 'status');
      const save = Object.assign(document.createElement('button'), { type: 'button', textContent: tr('保存') });
      save.addEventListener('click', async () => {
        const list = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
        try { await tb.invoke('saveRpcs', n.key, list); msg.textContent = list.length ? tr('已保存') : tr('已恢复内置节点'); } catch (e) { msg.textContent = errText(e); }
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
  tb.on('wallet', (w) => {
    const was = Boolean(wallet.ready);
    wallet = w || {};
    renderWallet();
    // 连上或断开钱包时，网站信息面板里的打赏一行要跟着变
    if (siteOpen && was !== Boolean(wallet.ready)) renderSite();
  });
  tb.on('bem', (v) => {
    bemView = v;
    renderBem(v);
    // 只更新打赏一行里的余额，不重画面板，免得清掉正在输入的数额
    const src = document.querySelector('#si-list [data-tip-net]');
    if (src) src.textContent = tipSource(src.dataset.tipNet, (siteInfo || {}).network);
  });

  /** 钱包按钮旁的 BEM：没连钱包只显示价格；连上后显示余额和折合美元，鼠标移上去看各条链 */
  const usd = (n) => (n >= 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 }));
  function renderBem(v) {
    const b = $('bem');
    b.hidden = !v || (v.price === null && !v.balance);
    if (b.hidden) return;
    b.textContent = '';
    b.className = '';
    const price = v.price !== null ? '$' + usd(v.price) : null;
    const lines = [tr('BEM 价格：{price}（PancakeSwap BEM/USDT 池的即时价格，仅供参考）', { price: price ?? tr('读取失败') })];
    const bal = v.balance;
    const span = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    // 价格一直显示在最前面
    b.append(span('unit', 'BEM'), span('price', price ?? '—'));
    if (bal) {
      // 连上钱包后接着显示持有数量和折合美元
      b.append(span('sep', '·'), document.createTextNode(bal.total ?? (bal.loading ? '…' : '—')));
      if (bal.usd !== null && bal.usd > 0) b.append(span('unit', '≈ $' + usd(bal.usd)));
      if (bal.networks.some((n) => n.error)) b.classList.add('stale');
      for (const n of bal.networks) lines.push(n.error ? tr('{name}：读取失败', { name: n.name }) : tr('{name}：{amount} BEM', { name: n.name, amount: n.balance ?? '…' }));
    }
    b.title = lines.join('\n') + '\n' + tr('点击刷新');
    b.setAttribute('aria-label', lines.join(tr('；')));
  }

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
    $('find-count').textContent = r.matches ? `${r.active} / ${r.matches}` : tr('无结果');
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
  $('lang').addEventListener('change', () => tb.invoke('setLang', $('lang').value));

  renderWallet();
  renderNav();
  tb.invoke('ready');
  reportBounds();
})();
