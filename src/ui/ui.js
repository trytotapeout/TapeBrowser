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
  // 用户手动选过的分栏；没选过时显示排在第一个的 DeWEB 应用
  let panel = null;
  let dirLimit = 200;
  let findOpen = false;
  let siteOpen = false;
  let siteInfo = null;
  // 当前页面的多节点交叉校验结果 {url, status, nodes, mismatches}
  let verify = null;
  // 当前网站容器里的资产 {url, assets} | {url, error}；打开网站信息面板时读一次
  let assets = null;
  // 安全体检：{url, running} 或体检报告（safety.js），用户点按钮才做
  let safety = null;
  // 「持有的全部网站」：下一次显示新标签页时按这个持有人筛选
  let pendingOwner = null;
  // 上次查询网站信息时的 标签 id + 网址 + 是否在加载，变化时才重新查询
  let siteKey = '';
  let editing = false;
  let settingsOpen = false;
  let helpOpen = false;
  // 分类筛选：'' 是全部
  let dirCat = '';
  // 分类的显示名，顺序就是筛选按钮的顺序
  const CATS = { game: tr('游戏'), finance: tr('金融'), tool: tr('工具'), social: tr('社交与内容'), infra: tr('生态'), other: tr('其他') };
  // DeWEB 应用、新上线的显示方式：cards | list，记在本机
  let dirView = localStorage.getItem('dirView') === 'list' ? 'list' : 'cards';
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
    closePages();
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
    $('newtab-page').hidden = settingsOpen || helpOpen || pub.open || Boolean(t && t.url);
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
    $('help-page').hidden = !helpOpen;
    $('publish-page').hidden = !pub.open;
    $('quickstart').hidden = library.history.length > 0;
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
  const isLocal = (u) => /^tape:\/\/local-[0-9a-f]{12}(?:[/?#]|$)/i.test(u || '');
  const isWeb = (u) => /^https?:\/\//i.test(u || '');
  const shortHex = (h) => (h && h.length > 20 ? h.slice(0, 10) + '…' + h.slice(-8) : h || '—');
  const SOURCE = { chain: tr('从链上下载'), cache: tr('链上哈希未变，使用本机缓存'), stale: tr('读链失败，显示的是上次缓存的版本') };

  /** 标签网址或加载状态变化时重新读取网站信息 */
  function refreshSite() {
    const t = active();
    const tape = Boolean(t && isTape(t.url));
    const web = Boolean(t && isWeb(t.url));
    $('site-btn').hidden = !tape && !web;
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
    // 普通网页：不在链上，内容来自对方服务器，没法校验，明确标出来
    if (web) {
      verify = null;
      const key = `${t.id}|${t.url}`;
      if (key !== siteKey) { siteKey = key; siteInfo = { web: true, url: t.url, insecure: /^http:/i.test(t.url) }; }
      renderSite();
      return;
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
      if (info && info.local) return;
      // 页面读完后再让另外两个节点交叉校验，不拖慢打开网页
      return tb.invoke('verifySite').then((v) => {
        if (siteKey !== key) return;
        verify = v;
        renderSite();
      });
    }).catch(() => {});
  }

  function siteState(info) {
    if (info && info.web) return { cls: 'web', text: info.insecure ? tr('未校验 · 未加密') : tr('未校验') };
    if (info && info.local) return localState(info);
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
    const local = Boolean(siteInfo && siteInfo.local);
    const web = Boolean(siteInfo && siteInfo.web);
    b.className = (st.cls === 'ok' ? '' : st.cls) + (local ? ' local' : '');
    b.textContent = local ? tr('本地') : st.cls === 'ok' ? tr('链上') : st.text;
    b.title = (local ? tr('本地预览：') : web ? tr('不在链上：') : tr('网站信息：')) + st.text;
    if (!siteOpen) return;
    if (local) { renderLocal(siteInfo, st); return; }
    if (web) { renderWeb(siteInfo, st); return; }
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
    // https 分享链接：没装 TapeBrowser 的人打开会看到下载按钮，装了的直接唤起
    const share = shareUrl(info, active() && active().url);
    if (share) row(tr('分享链接'), share, share);
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
    if (info.container && info.opened) safetyRow(dl);
    if (info.container && info.opened) tipRow(row, info);
  }

  /** 本地预览的状态：按预检查最严重的一级 */
  function localState(info) {
    if (info.error) return { cls: 'bad', text: tr('读取失败') };
    const items = (info.check && info.check.items) || [];
    const n = (level) => items.filter((i) => i.level === level).length;
    if (n('error')) return { cls: 'bad', text: tr('{n} 个错误', { n: n('error') }) };
    if (n('warn')) return { cls: 'stale', text: tr('{n} 个警告', { n: n('warn') }) };
    return { cls: 'ok', text: tr('预检查通过') };
  }

  const LEVELS = { error: tr('错误'), warn: tr('警告'), info: tr('提示') };
  const size = (n) => (n < 1024 ? n + tr(' 字节') : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1024 / 1024).toFixed(2) + ' MB');

  /** 本地预览的面板：文件夹、发布内容、预检查结果和目录卡片预览 */
  function renderLocal(info, st) {
    $('si-label').textContent = tr('本地预览 · 未上链');
    $('si-status').textContent = st.text;
    $('si-status').className = st.cls;
    const dl = $('si-list');
    dl.textContent = '';
    const row = (name) => {
      const dd = document.createElement('dd');
      dl.append(Object.assign(document.createElement('dt'), { textContent: name }), dd);
      return dd;
    };
    const text = (dd, value) => dd.append(Object.assign(document.createElement('span'), { className: 'v', textContent: value, title: value }));
    if (info.error) { text(row(tr('错误')), info.error); return; }
    const folder = row(tr('文件夹'));
    text(folder, info.root);
    const reveal = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: tr('打开文件夹') });
    reveal.addEventListener('click', () => tb.invoke('revealLocal'));
    folder.append(reveal);
    const c = info.check;
    text(row(tr('发布内容')), tr('{files} 个文件，共 {size}，全部上传约 {txs} 笔交易（每 24 KB 一笔）', { files: c.summary.files, size: size(c.summary.bytes), txs: c.summary.txs }));
    text(row(tr('外部资源')), externalText(info.external || []));

    const checks = row(tr('预检查'));
    checks.className = 'checks';
    if (!c.items.length) text(checks, tr('没有发现问题'));
    else {
      const ul = Object.assign(document.createElement('ul'), { className: 'check-list' });
      for (const it of c.items) {
        const li = Object.assign(document.createElement('li'), { className: it.level });
        li.append(Object.assign(document.createElement('span'), { className: 'lv', textContent: LEVELS[it.level] }), document.createTextNode(it.text));
        ul.append(li);
      }
      checks.append(ul);
    }
    row(tr('卡片预览')).append(localCard(c.card));
    safetyRow(dl);
    // 发布到容器：打开全屏发布页
    const go = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: tr('发布到容器…') });
    go.addEventListener('click', () => openPublish(true));
    row(tr('发布')).append(go);
  }

  const LEVEL_TEXT = { danger: tr('高危'), warn: tr('留意'), info: tr('信息') };
  const KIND_TEXT = { contract: tr('合约'), wallet: tr('普通钱包'), unknown: tr('未知') };

  // 钱包操作只说明网站「能」请你做什么，正规应用也会用到，最高一级叫「警告」，不和体检结论里的「高危」混在一起
  const ABILITY_TEXT = { ...LEVEL_TEXT, danger: tr('警告') };

  /** 一组带级别的条目：[{level, text, where}] */
  function levelList(items, text = LEVEL_TEXT) {
    const ul = Object.assign(document.createElement('ul'), { className: 'check-list' });
    for (const it of items) {
      const li = Object.assign(document.createElement('li'), { className: it.level === 'danger' ? 'error' : it.level });
      li.append(Object.assign(document.createElement('span'), { className: 'lv', textContent: text[it.level] }), document.createTextNode(it.text));
      if (it.where && it.where.length) li.append(Object.assign(document.createElement('span'), { className: 'where', textContent: ' ' + it.where.join(tr('、')) }));
      ul.append(li);
    }
    return ul;
  }

  /** 安全体检一行：没做过时是按钮，做完显示报告 */
  function safetyRow(dl) {
    const dd = Object.assign(document.createElement('dd'), { className: 'checks' });
    dl.append(Object.assign(document.createElement('dt'), { textContent: tr('安全体检') }), dd);
    const url = active() && active().url;
    const r = safety && safety.url === url ? safety : null;
    const go = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: r && !r.running ? tr('重新体检') : tr('开始体检') });
    go.disabled = Boolean(r && r.running);
    go.addEventListener('click', () => runSafety(url));
    const hint = (t) => dd.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t }));
    if (!r) {
      hint(tr('读取这个网站的全部文件，分析它会请你签什么、钱会流向哪里，以及有没有盗币、钓鱼的特征。只在本机分析，不上传任何内容'));
      dd.append(go);
      return;
    }
    if (r.running) { hint(tr('正在读取全部文件并分析，网站大的话要几十秒…')); return; }
    if (r.error) { hint(tr('体检失败：') + r.error); dd.append(go); return; }

    const danger = r.findings.filter((f) => f.level === 'danger').length;
    const head = Object.assign(document.createElement('p'), { className: 'verdict ' + (danger ? 'bad' : r.findings.length ? 'stale' : 'ok') });
    head.textContent = danger ? tr('发现 {n} 个高危特征，不要连接钱包、不要签名', { n: danger })
      : r.findings.some((f) => f.level === 'warn') ? tr('没有发现高危特征，但有需要留意的地方')
        : tr('没有发现已知的作恶特征');
    dd.append(head);
    const section = (title, node) => {
      dd.append(Object.assign(document.createElement('h4'), { textContent: title }));
      dd.append(node);
    };
    if (r.findings.length || (r.context || []).length) section(tr('发现'), levelList([...r.findings, ...(r.context || [])]));
    section(tr('这个网站可能请你做的钱包操作'), r.abilities.length ? levelList(r.abilities, ABILITY_TEXT) : Object.assign(document.createElement('p'), { className: 'hint', textContent: tr('代码里没有找到钱包调用') }));
    if (r.addresses.length) {
      const ul = Object.assign(document.createElement('ul'), { className: 'addr-list' });
      for (const a of r.addresses.slice(0, 12)) {
        const li = document.createElement('li');
        li.append(Object.assign(document.createElement('span'), { className: 'kind ' + a.kind, textContent: KIND_TEXT[a.kind] }), Object.assign(document.createElement('code'), { textContent: a.address, title: a.where.join('\n') }));
        ul.append(li);
      }
      section(tr('代码里写死的地址（{n} 个）', { n: r.addresses.length }), ul);
    }
    const cov = r.coverage;
    const notes = [tr('分析了 {files} 个文件中的文本文件，共 {size}，用时 {s} 秒', { files: cov.files, size: size(cov.scanned), s: (r.ms / 1000).toFixed(1) })];
    if (cov.skipped.length) notes.push(tr('没有检查：{list}', { list: cov.skipped.slice(0, 5).join(tr('、')) + (cov.skipped.length > 5 ? tr(' 等 {n} 个', { n: cov.skipped.length }) : '') }));
    notes.push(tr('这是静态特征检查：能认出常见的盗币工具包、钓鱼和骗助记词页面，但「没有发现」不等于安全。作者有意规避时（例如按时间或钱包触发）查不出来'));
    for (const n of notes) hint(n);
    dd.append(go);
  }

  function runSafety(url) {
    safety = { url, running: true };
    renderSite();
    tb.invoke('safetyCheck').then((r) => {
      if (!r || r.url !== url) return;
      safety = r;
      if (siteOpen) renderSite();
    }).catch((e) => { safety = { url, error: errText(e) }; if (siteOpen) renderSite(); });
  }

  /** 普通网页的面板：说明内容不在链上、TapeBrowser 证明不了它，签名时仍有风险解读 */
  function renderWeb(info, st) {
    let host = info.url;
    try { host = new URL(info.url).host; } catch { /* 原样显示 */ }
    $('si-label').textContent = host;
    $('si-status').textContent = st.text;
    $('si-status').className = st.cls;
    const dl = $('si-list');
    dl.textContent = '';
    const row = (name, value) => {
      const dd = document.createElement('dd');
      dd.append(Object.assign(document.createElement('span'), { className: 'v wrap', textContent: value }));
      dl.append(Object.assign(document.createElement('dt'), { textContent: name }), dd);
    };
    row(tr('内容来源'), tr('对方的服务器，不在链上。TapeBrowser 无法证明你看到的代码是谁写的、有没有被改过，服务器也可以给不同的人返回不同的内容'));
    if (info.insecure) row(tr('连接方式'), tr('没有加密（http），网络上的其他人可以看到和篡改页面'));
    row(tr('钱包'), tr('签名和交易仍会经过 TapeBrowser 的风险解读，但判断不了网站本身是否可信。连接钱包、授权前请核对网址'));
    row(tr('更可信的做法'), tr('如果这个应用有链上版本（tape:// 网站），优先用链上版本：文件经过 SHA-256 校验，持有人和每次更新都公开记录在链上'));
  }

  /** 目录卡片预览：和「DeWEB 应用」里的卡片同样的样式，不能点 */
  function localCard(card) {
    const box = Object.assign(document.createElement('div'), { className: 'card preview' });
    const thumb = Object.assign(document.createElement('div'), { className: 'thumb' + (card.title ? '' : ' untitled') });
    thumb.style.setProperty('--hue', hueOf(card.title || 'local'));
    thumb.append(Object.assign(document.createElement('span'), { className: 'initial', textContent: (card.title ? Array.from(card.title.trim())[0] || '#' : '#').toUpperCase() }));
    thumb.append(catTag(card));
    const kind = card.cover ? 'cover' : card.logo ? 'logo' : null;
    if (kind) {
      tb.invoke('localImage', kind).then((src) => {
        if (!src) return;
        const img = Object.assign(document.createElement('img'), { src, alt: '', className: kind });
        img.addEventListener('load', () => thumb.classList.add('has-' + kind));
        thumb.append(img);
      }).catch(() => {});
    }
    const body = Object.assign(document.createElement('div'), { className: 'body' });
    body.append(Object.assign(document.createElement('div'), { className: 't' + (card.title ? '' : ' untitled'), textContent: card.title || tr('（没有标题）') }));
    box.append(thumb, body);
    return box;
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
    if (!url || !isTape(url) || isLocal(url)) return;
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

  // 产品站上的分享落地页（github_pages/open/）
  const SHARE_BASE = 'https://trytotapeout.github.io/TapeBrowser/open/?';
  /** 4454.0、1.2.248，带上当前页面的路径（首页不带） */
  function shareUrl(info, url) {
    if (!info || !info.label) return null;
    const m = /^tape:\/\/[^/?#]+(\/[^?#]*)?/i.exec(url || '');
    const path = m && m[1] && m[1] !== '/' && m[1] !== '/index.html' ? m[1] : '';
    return SHARE_BASE + info.label.replace(/\.tape$/, '') + path;
  }

  /** 持有人一行后面加「持有的全部网站」：在新标签页的 DeWEB 应用里按持有人筛选 */
  function ownerLink(owner) {
    const dd = $('si-list').lastElementChild;
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: tr('持有的全部网站') });
    b.title = tr('在 DeWEB 应用里查看这个地址持有的网站');
    b.addEventListener('click', () => showOwner(owner));
    dd.append(b);
  }

  /** 打开新标签页，DeWEB 应用按持有人筛选 */
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
    const cur = panel || 'directory';
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

  /** DeWEB 应用：按搜索词过滤、排序，只渲染前 dirLimit 条 */
  function renderDirectory() {
    const st = dir.status;
    $('dir-count').textContent = st.count ? String(st.count) : '';
    $('dir-status').textContent = dirStatusText(st);
    $('dir-refresh').hidden = Boolean(st.running);
    const q = $('dir-search').value.trim().toLowerCase();
    const netFilter = $('dir-net').value;
    let items = netFilter ? dir.sites.filter((s) => (s.network || 'bnb') === netFilter) : dir.sites;
    renderCats(items);
    if (dirCat) items = items.filter((s) => (s.category || 'other') === dirCat);
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
    ul.className = dirView === 'cards' ? 'cards' : 'list links';
    for (const it of items.slice(0, dirLimit)) ul.append(dirItem(it, it.updatedAt));
    for (const b of document.querySelectorAll('#dir-view button')) b.setAttribute('aria-pressed', String(b.dataset.view === dirView));
    $('dir-more').hidden = items.length <= dirLimit;
    $('dir-more').textContent = tr('显示更多（还有 {0} 个）', { 0: items.length - dirLimit });
    renderNewSites();
  }

  /** 分类筛选按钮，带上当前链筛选下每类的数量；没有网站的分类不显示 */
  function renderCats(items) {
    const box = $('dir-cats');
    const count = {};
    for (const s of items) count[s.category || 'other'] = (count[s.category || 'other'] || 0) + 1;
    if (dirCat && !count[dirCat]) dirCat = '';
    box.textContent = '';
    const chip = (key, label, n) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chip' });
      b.append(label, Object.assign(document.createElement('span'), { className: 'n', textContent: String(n) }));
      b.setAttribute('aria-pressed', String(dirCat === key));
      b.addEventListener('click', () => { dirCat = key; dirLimit = 200; renderDirectory(); });
      box.append(b);
    };
    chip('', tr('全部'), items.length);
    for (const [key, label] of Object.entries(CATS)) if (count[key]) chip(key, label, count[key]);
  }

  /** 卡片上的分类标签：推测的标「推测」，鼠标移上去看依据 */
  function catTag(it) {
    const key = it.category || 'other';
    const tag = Object.assign(document.createElement('span'), { className: 'cat ' + key, textContent: CATS[key] });
    if (it.categoryFrom === 'declared') tag.title = tr('站长在 deweb.json 里声明的分类');
    else {
      tag.classList.add('guess');
      tag.title = tr('推测的分类') + (it.categoryWhy && it.categoryWhy.length ? tr('，依据：') + it.categoryWhy.join(tr('，')) : '');
    }
    return tag;
  }

  /** 占位图的色相：按网站地址算，同一个网站每次都一样 */
  function hueOf(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  // 卡片图片按 网址 + 种类 + sha256 缓存在内存里，重新渲染列表不重复读取
  const images = new Map();
  function loadThumb(thumb) {
    const { url, kind, sha } = thumb.dataset;
    const key = `${url}|${kind}|${sha}`;
    if (!images.has(key)) images.set(key, tb.invoke('siteImage', url, kind).catch(() => null));
    images.get(key).then((src) => {
      if (!src || !thumb.isConnected) return;
      const img = Object.assign(document.createElement('img'), { src, alt: '', className: kind });
      img.addEventListener('load', () => thumb.classList.add('has-' + kind));
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    });
  }
  const thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      loadThumb(e.target);
    }
  }, { rootMargin: '300px' });

  /** 目录里的一个网站：卡片或一行；date 是显示的上链时间（秒） */
  function dirItem(it, date) {
    return dirView === 'cards' ? dirCard(it, date) : dirRow(it, date);
  }

  function openOnClick(a, url) {
    // ⌘ 点击或中键在后台标签打开
    a.addEventListener('click', (e) => { e.preventDefault(); tb.invoke('openUrl', url, { background: e.metaKey || e.ctrlKey }); });
    a.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); tb.invoke('openUrl', url, { background: true }); } });
  }

  function dirCard(it, date) {
    const li = Object.assign(document.createElement('li'), { className: 'card' });
    const net = it.network || 'bnb';
    const a = Object.assign(document.createElement('a'), { href: it.url, title: tr('{url}\n持有人 {owner}', { url: it.url, owner: it.owner }) });
    const thumb = Object.assign(document.createElement('div'), { className: 'thumb' + (it.title ? '' : ' untitled') });
    // 占位底色：按网站地址算一个固定的色相，只取很淡的一层，同一个网站每次都一样
    thumb.style.setProperty('--hue', hueOf(it.url));
    // 首字取自标题（按字符，不会切开 emoji）；没有标题显示电路编号
    const first = it.title ? Array.from(it.title.trim())[0] || '#' : '#' + it.tokenId;
    thumb.append(Object.assign(document.createElement('span'), { className: 'initial', textContent: first.toUpperCase() }));
    thumb.setAttribute('aria-hidden', 'true');
    // 站长放了 cover（铺满）或 logo（居中）就显示，滚动到附近才读取；读不到保留占位
    const pic = it.cover ? ['cover', it.cover] : it.logo ? ['logo', it.logo] : null;
    if (pic) {
      thumb.dataset.url = it.url;
      thumb.dataset.kind = pic[0];
      thumb.dataset.sha = pic[1].sha256;
      thumbObserver.observe(thumb);
    }
    const body = Object.assign(document.createElement('div'), { className: 'body' });
    const meta = Object.assign(document.createElement('div'), { className: 'meta' });
    meta.append(
      Object.assign(document.createElement('span'), { className: 'net ' + net, textContent: NET_SHORT[net] }),
      Object.assign(document.createElement('span'), { className: 'u', textContent: it.label }),
      Object.assign(document.createElement('span'), { className: 'd', textContent: day(date) }),
    );
    body.append(
      Object.assign(document.createElement('div'), { className: 't' + (it.title ? '' : ' untitled'), textContent: it.title || tr('（没有标题）') }),
      meta,
    );
    // 图片区对读屏隐藏，分类再放一份只给读屏的文字
    thumb.append(catTag(it));
    body.prepend(Object.assign(document.createElement('span'), { className: 'sr-only', textContent: CATS[it.category || 'other'] + tr('：') }));
    a.append(thumb, body);
    openOnClick(a, it.url);
    li.append(a);
    return li;
  }

  function dirRow(it, date) {
    const li = document.createElement('li');
    // 标题来自网站自己的 HTML，只用 textContent
    const a = Object.assign(document.createElement('a'), { href: it.url, title: tr('{url}\n持有人 {owner}', { url: it.url, owner: it.owner }) });
    a.append(
      Object.assign(document.createElement('span'), { className: 't' + (it.title ? '' : ' untitled'), textContent: it.title || tr('（没有标题）') }),
      Object.assign(document.createElement('span'), { className: 'net ' + (it.network || 'bnb'), textContent: NET_SHORT[it.network || 'bnb'] }),
      Object.assign(document.createElement('span'), { className: 'u', textContent: it.label }),
      Object.assign(document.createElement('span'), { className: 'd', textContent: day(date) }),
    );
    openOnClick(a, it.url);
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
    ul.className = dirView === 'cards' ? 'cards' : 'list links';
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

  /** 关掉设置页和帮助页，回到当前标签 */
  function closePages() {
    if (settingsOpen) setSettings(false);
    if (helpOpen) setHelp(false);
    if (pub.open) openPublish(false);
  }

  function setHelp(on) {
    helpOpen = on;
    if (on && settingsOpen) settingsOpen = false;
    if (on) pub.open = false;
    tb.invoke('overlay', on || settingsOpen || pub.open);
    renderNav();
  }

  async function setSettings(on) {
    settingsOpen = on;
    if (on) { helpOpen = false; pub.open = false; }
    tb.invoke('overlay', on || pub.open);
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

  // ---- 发布到容器：全屏页面，和设置页一样盖住网页（overlay） ----
  // 主进程只给脱敏摘要和 id（契约第 2 条）；这里按 id、链和电路编号调用，按错误码决定提示和按钮（契约第 7 条）
  const PUB_NETS = [{ key: 'bnb', name: 'BNB Chain', currency: 'BNB' }, { key: 'xlayer', name: 'X Layer', currency: 'OKB' }];
  const pubNet = (key) => PUB_NETS.find((n) => n.key === key) || null;
  // 发布页的全部状态
  const pub = {
    open: false,
    url: null,        // 打开发布页时的本地预览网址，inspect 在主进程里按它找文件夹
    root: null,       // 本地文件夹路径，只用来显示
    available: null,  // publishAvailable：{ ok, reason }
    netKey: null,
    targets: null,    // publishTargets：{ circuits, skipped } | { error }
    scan: null,       // publishScan 的最新进度
    pick: null,       // 选中的电路 { tokenId, cpu }
    plan: null,       // inspect 摘要 | { error }
    run: null,        // 正在发布：{ id, site, stage, done, total, path, index, hash, wallet, pausing, warn }
    result: null,     // 发布结束：run 的结果 + { id, site } | { error, id, site }
    leftovers: null,  // publishLeftovers
    flash: null,      // 页面顶部的一条提示 { level, text }（退款、放弃零头的结果之类）
    busy: new Set(),  // 正在等结果的调用，相关按钮禁用
    seq: 0,           // 选链、选电路的序号：过时的结果直接丢掉
    leftSeq: 0,       // 读残留列表的序号
  };
  const AVAIL_TEXT = {
    'no-encryption': tr('这台电脑的系统钥匙串不可用，无法安全保存发布用的临时钱包，所以不能发布。'),
    'basic-text': tr('这台电脑没有可用的系统密码库（只能明文保存），无法安全保存发布用的临时钱包，所以不能发布。'),
  };

  /**
   * 十进制字符串（wei）→ 数额：去掉末尾的 0，小数最多 6 位有效数字。
   * round：'up' 向上取（花费，宁可多报）、'down' 向下取（退回、余额，宁可少报）、'exact' 全部位数（放在 title 里）
   */
  function formatUnits(raw, decimals = 18, round = 'down') {
    let v;
    try { v = BigInt(raw); } catch { return '—'; }
    const neg = v < 0n;
    if (neg) v = -v;
    const base = 10n ** BigInt(decimals);
    // 保留几位小数：整数部分不为 0 时 6 位，否则从第一个非 0 位起 6 位
    let keep = decimals;
    if (round !== 'exact') {
      const lead = (v % base).toString().padStart(decimals, '0').search(/[1-9]/);
      keep = Math.min(decimals, v >= base || lead < 0 ? 6 : lead + 6);
    }
    const unit = 10n ** BigInt(decimals - keep);
    let q = v / unit;
    if (round === 'up' && v % unit) q += 1n;
    const scale = 10n ** BigInt(keep);
    const frac = keep ? (q % scale).toString().padStart(keep, '0').replace(/0+$/, '') : '';
    return (neg ? '-' : '') + (q / scale).toString() + (frac ? '.' + frac : '');
  }
  const currencyOf = (netKey) => (pubNet(netKey) || {}).currency || '';
  /** 数额加币种；花费用 'up'，退回和余额用 'down' */
  const coin = (raw, netKey, round = 'down') => `${formatUnits(raw, 18, round)} ${currencyOf(netKey)}`.trim();
  /** 全部位数，鼠标移上去看 */
  const exact = (raw, netKey) => `${formatUnits(raw, 18, 'exact')} ${currencyOf(netKey)}`.trim();
  /** 建一个元素：props 直接赋值，kids 是元素或文字（文字一律当文本节点，不解析 HTML） */
  const mk = (tag, props, ...kids) => {
    const el = Object.assign(document.createElement(tag), props || {});
    el.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
    return el;
  };
  const shortAddr = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
  // 在发布前就会被拒绝、碰不到临时钱包的错误：没有残留记录时不给「退款」
  const PRE_START = new Set(['BUSY', 'NOT_READY', 'NO_ENCRYPTION', 'BAD_ARGS', 'CHAIN_UNSUPPORTED', 'NOT_LOCAL', 'CIRCUIT_MISSING', 'LOCAL_FILES']);
  const originOfUrl = (u) => (/^tape:\/\/[^/?#]+/i.exec(u || '') || [''])[0].toLowerCase();

  /**
   * 调用发布 IPC：key 记进 busy（相关按钮禁用），返回 { ok, value } | { error } | { cancelled }。
   * invoke 自己抛错也转成 { error }；NO_ENCRYPTION 时整页只显示原因
   */
  async function pubCall(key, name, ...args) {
    pub.busy.add(key);
    renderPublish();
    let r;
    try {
      r = await tb.invoke(name, ...args);
      if (!r || typeof r !== 'object') r = { error: { code: null, message: tr('发布服务没有回应') } };
    } catch (e) {
      r = { error: { code: null, message: errText(e) } };
    }
    pub.busy.delete(key);
    if (r.error && r.error.code === 'NO_ENCRYPTION') pub.available = { ok: false, error: r.error.message };
    renderPublish();
    return r;
  }

  /** 打开 / 关闭发布页。只能从本地预览打开；换了文件夹时从选链开始（正在发布时保留进度） */
  function openPublish(on) {
    if (on) {
      const t = active();
      if (!pub.run && !(t && isLocal(t.url))) { notice(tr('请先在本地预览里打开要发布的文件夹'), 'error'); return; }
      if (!pub.run && originOfUrl(pub.url) !== originOfUrl(t.url)) {
        Object.assign(pub, { url: t.url, root: null, netKey: null, targets: null, scan: null, pick: null, plan: null, result: null });
        pub.seq++;
      }
      if (!pub.run && siteInfo && siteInfo.local && siteInfo.root) pub.root = siteInfo.root;
      settingsOpen = false;
      helpOpen = false;
      if (siteOpen) setSite(false);
    }
    pub.open = on;
    tb.invoke('overlay', on);
    renderNav();
    if (!on) return;
    renderPublish();
    $('pub-title').focus();
    if (!pub.root && !pub.run) loadRoot(pub.url);
    loadPublish();
  }

  /** 网站信息还没读到时，单独读一次本地文件夹的路径（计划里要写明发布的是哪个文件夹） */
  async function loadRoot(url) {
    try {
      const info = await tb.invoke('siteInfo');
      if (pub.url === url && !pub.root && info && info.local && info.root) { pub.root = info.root; renderPublish(); }
    } catch { /* 显示网址代替 */ }
  }

  async function loadPublish() {
    const a = await pubCall('available', 'publishAvailable');
    pub.available = a.error ? { ok: false, error: a.error.message } : a.value;
    renderPublish();
    if (pub.available && pub.available.ok) await loadLeftovers();
  }

  async function loadLeftovers() {
    const seq = ++pub.leftSeq;
    const r = await pubCall('leftovers', 'publishLeftovers');
    if (seq !== pub.leftSeq) return;
    pub.leftovers = r.error ? { error: r.error.message } : r.value;
    renderPublish();
  }

  /** 选链：读这个钱包在链上的电路。container 给了就在读完后选中这个容器的电路（残留记录的「继续发布」） */
  async function chooseNet(key, container = null) {
    if (pub.run || !pubNet(key)) return;
    const seq = ++pub.seq;
    Object.assign(pub, { netKey: key, targets: null, scan: null, pick: null, plan: null, result: null });
    renderPublish();
    // 没连钱包时页面提示先连接；连上后 tb.on('wallet') 会重新读
    if (!wallet.ready || !wallet.account) return;
    const r = await pubCall('targets', 'publishTargets', key);
    if (seq !== pub.seq) return;
    pub.targets = r.error ? { error: r.error } : r.value;
    pub.scan = null;
    renderPublish();
    if (!container || r.error) return;
    const c = (r.value.circuits || []).find((x) => String(x.container).toLowerCase() === container.toLowerCase());
    if (c) chooseTarget(c);
    else notice(tr('当前钱包持有的电路里没有这个容器：换成它的持有人的钱包再继续，或者直接退款'), 'error');
  }
  /** 选电路：选好就自动检查（inspect） */
  function chooseTarget(c) {
    if (pub.run) return;
    pub.pick = { tokenId: Number(c.tokenId), cpu: Number(c.cpu), label: c.label, container: c.container };
    pub.result = null;
    inspectPick();
  }

  /** 按选中的链和电路检查一次；返回新的摘要（出错时为 null） */
  async function inspectPick() {
    if (!pub.pick || !pub.netKey || pub.run) return null;
    const seq = ++pub.seq;
    pub.plan = null;
    const { tokenId, cpu } = pub.pick;
    const r = await pubCall('inspect', 'publishInspect', { url: pub.url, netKey: pub.netKey, tokenId, cpu });
    if (seq !== pub.seq) return null;
    pub.plan = r.error ? { error: r.error } : r.value;
    renderPublish();
    return r.error ? null : r.value;
  }

  /** 按 id 发布（「开始发布」和「继续发布」）。done 之后 id 作废，paused 或出错时同一个 id 可以再 run */
  async function startRun(id) {
    const plan = pub.plan && pub.plan.id === id ? pub.plan : null;
    const base = { id, netKey: pub.netKey, label: (plan && plan.label) || (pub.pick && pub.pick.label), url: plan && plan.url, container: (plan && plan.container) || (pub.pick && pub.pick.container), openFee: plan && !plan.opened ? plan.openFee : null };
    pub.result = null;
    pub.flash = null;
    pub.run = { ...base, stage: 'start', started: false };
    const r = await pubCall('run', 'publishRun', id);
    const started = pub.run && pub.run.started;
    pub.run = null;
    if (r.error) pub.result = { ...base, error: r.error, started };
    else if (r.value.stage === 'paused') pub.result = { ...base, paused: true };
    else {
      pub.result = { ...base, ...r.value, url: base.url };
      pub.plan = null;
    }
    renderPublish();
    loadLeftovers();
  }

  /** 「继续发布」：先用原来的 id；主进程里已经没有这次检查（重启过、检查太多被挤掉）就重新检查再发 */
  async function continueRun(id) {
    if (id) {
      await startRun(id);
      if (!(pub.result && pub.result.error && pub.result.error.code === 'NOT_READY')) return;
      // 主进程里没有这次检查了：回到计划，按最新状态重新检查后接着发
      pub.result = null;
    }
    const plan = await inspectPick();
    if (plan && plan.stage === 'ready' && plan.id) await startRun(plan.id);
  }

  async function pausePublish() {
    if (!pub.run) return;
    const id = pub.run.id;
    const r = await pubCall('pause', 'publishPause', id);
    if (pub.run && pub.run.id === id && !r.error && r.value) pub.run.pausing = true;
    if (r.error) notice(r.error.message, 'error');
    renderPublish();
  }

  /** 退款 / 放弃零头：主进程先弹确认框，用户取消时什么也不做 */
  async function refundLeft(netKey, container) {
    const r = await pubCall('refund:' + container, 'publishRefund', { netKey, container });
    if (r.cancelled) return;
    if (r.error) pub.flash = { level: 'bad', text: r.error.message };
    else if (r.value.dust) pub.flash = { level: 'warn', text: tr('临时钱包里只剩一点零头，不够付退款的手续费，没有退。可以在下面「放弃零头」') };
    else pub.flash = { level: 'ok', text: tr('已退回 {amount} 到持有人地址', { amount: coin(r.value.refunded, netKey) }) };
    if (!r.error && pub.result && pub.result.container === container) pub.result = null;
    renderPublish();
    loadLeftovers();
  }

  async function discardLeft(netKey, container) {
    const r = await pubCall('discard:' + container, 'publishDiscard', { netKey, container });
    if (r.cancelled) return;
    pub.flash = r.error ? { level: 'bad', text: r.error.message } : { level: 'ok', text: tr('已放弃 {amount} 零头，删掉了这个临时钱包', { amount: coin(r.value.discarded, netKey) }) };
    renderPublish();
    loadLeftovers();
  }
  /** 残留记录的「继续发布」：选好链，读完电路后选中这个容器的电路并检查 */
  function resumeLeft(rec) {
    if (!wallet.ready || !wallet.account) { notice(tr('请先连接钱包'), 'error'); return; }
    $('content').scrollTop = 0;
    chooseNet(rec.netKey, rec.container);
  }

  const leftoverOf = (netKey, container) => ((pub.leftovers && pub.leftovers.records) || [])
    .find((r) => r.netKey === netKey && container && r.container.toLowerCase() === String(container).toLowerCase()) || null;
  /**
   * 暂停或出错的这次发布要不要给「退款」：残留列表里有这个容器就一定给（不管什么错误码，钱可能还在临时钱包里）；
   * 不在列表里时，发布前就被拒绝的错误和核验失败（已经退过款）不给，其余的只要开始过就给
   */
  const canRefund = (res) => {
    if (!res.container) return false;
    if (leftoverOf(res.netKey, res.container)) return true;
    if (res.error && (PRE_START.has(res.error.code) || res.error.code === 'VERIFY_FAILED')) return false;
    return Boolean(res.paused || res.started);
  };

  async function openSite(url) {
    if (!/^tape:\/\/[0-9a-z-]+\/$/i.test(url || '')) return;
    openPublish(false);
    await tb.invoke('newTab');
    tb.invoke('openUrl', url);
  }

  // 发布进度：只认当前这次 run 的 id
  tb.on('publish', (e) => {
    const r = pub.run;
    if (!r || !e || e.id !== r.id) return;
    r.started = true;
    if (e.stage === 'wallet') {
      r.wallet = e.kind;
      r.stage = e.kind;
      r.hash = null;
    } else {
      r.wallet = null;
      if (e.stage !== r.stage) { r.done = null; r.total = null; r.path = null; r.index = null; }
      r.stage = e.stage;
      for (const k of ['done', 'total', 'path', 'index', 'hash']) if (e[k] !== undefined) r[k] = e[k];
      if (e.stage === 'refund' && e.error) r.warn = tr('退款出错：{message}', { message: e.error });
    }
    renderPublish();
  });
  tb.on('publishScan', (p) => {
    if (!p || p.netKey !== pub.netKey || pub.targets) return;
    pub.scan = p;
    renderPublish();
  });
  const note = (text, level) => mk('p', { className: 'pub-note' + (level ? ' ' + level : ''), textContent: text });
  const button = (text, onClick, { busy = null, primary = false, link = false, disabled = false } = {}) => {
    const b = mk('button', { type: 'button', textContent: text, className: link ? 'link' : primary ? 'primary' : '' });
    b.disabled = disabled || Boolean(busy && pub.busy.has(busy));
    b.addEventListener('click', onClick);
    return b;
  };
  /** 两列的说明：[[名称, 值, 类名, title]]，title 放数额的全部位数 */
  const facts = (rows) => {
    const dl = mk('dl', { className: 'pub-facts' });
    for (const [k, v, cls, title] of rows) if (v !== null && v !== undefined) dl.append(mk('dt', { textContent: k }), mk('dd', { textContent: v, className: cls || '', title: title || '' }));
    return dl;
  };
  const levelLabel = (level) => LEVELS[level] || LEVELS.info;
  const checkList = (items) => {
    const ul = mk('ul', { className: 'check-list' });
    for (const it of items) ul.append(mk('li', { className: it.level }, mk('span', { className: 'lv', textContent: levelLabel(it.level) }), it.text));
    return ul;
  };

  /** 整个发布页：每次状态变化都整页重画（内容不多），没有输入框，不怕丢焦点 */
  function renderPublish() {
    if (!pub.open) return;
    $('pub-source').textContent = pub.root ? tr('发布本地文件夹：{root}', { root: pub.root }) : tr('发布当前本地预览的文件夹');
    const av = pub.available;
    const blocked = av && !av.ok;
    $('pub-blocked').hidden = !blocked;
    if (blocked) $('pub-blocked').textContent = av.error || AVAIL_TEXT[av.reason] || tr('暂时不能发布');
    $('pub-body').hidden = !av || blocked;
    if (!av || blocked) return;
    renderPublishChain();
    renderTargets();
    renderPlan();
    renderRun();
    renderLeftovers();
  }

  function renderPublishChain() {
    const box = $('pub-chain');
    box.textContent = '';
    if (pub.flash) box.append(mk('p', { className: 'pub-banner ' + pub.flash.level, textContent: pub.flash.text, role: 'status' }));
    const row = mk('div', { className: 'pub-chains', role: 'group' });
    row.setAttribute('aria-label', tr('选链'));
    for (const n of PUB_NETS) {
      const b = button(n.name, () => chooseNet(n.key), { disabled: Boolean(pub.run) });
      b.setAttribute('aria-pressed', String(pub.netKey === n.key));
      row.append(b);
    }
    box.append(row);
    if (!wallet.ready || !wallet.account) {
      box.append(note(wallet.connected ? tr('桥接页面已打开，请在系统浏览器里选择钱包并授权，然后回到这里。') : tr('发布要用电路持有人的钱包签名。请先连接钱包。'), 'warn'));
      if (!wallet.connected) box.append(mk('div', { className: 'pub-actions' }, button(tr('连接钱包'), () => tb.invoke('openBridge'))));
    } else if (!pub.netKey) {
      box.append(note(tr('选择网站要发布到哪条链。钱包会在需要时请你切换到这条链。')));
    }
  }
  /** 扫电路的进度：处理器列表 → 余额 → 逐个处理器找编号 → 读容器信息 */
  function scanText(p) {
    if (!p) return tr('正在读取钱包持有的电路…');
    if (p.stage === 'balances') return tr('正在检查钱包在 {n} 个处理器上的电路…', { n: p.total });
    if (p.stage === 'ids') return tr('正在查找处理器 {cpu} 上的电路编号（{done} / {total}）…', { cpu: p.cpu, done: p.done, total: p.total });
    if (p.stage === 'circuits') return tr('正在读取 {n} 个电路的容器信息…', { n: p.total });
    return tr('正在读取钱包持有的电路…');
  }

  function renderTargets() {
    const sec = $('pub-targets-sec');
    const box = $('pub-targets');
    sec.hidden = !pub.netKey || !wallet.ready || !wallet.account;
    box.textContent = '';
    if (sec.hidden) return;
    const t = pub.targets;
    if (!t) { box.append(note(scanText(pub.scan))); return; }
    if (t.error) {
      box.append(note(t.error.message, 'bad'), mk('div', { className: 'pub-actions' }, button(tr('重新读取'), () => chooseNet(pub.netKey), { busy: 'targets' })));
      return;
    }
    const net = pubNet(pub.netKey);
    if (!t.circuits.length) box.append(note(tr('当前钱包在 {name} 上没有电路。电路要先在 TapeOut 官网铸造，持有后才能发布网站。', { name: net.name }), 'warn'));
    const ul = mk('ul', { className: 'list' });
    for (const c of t.circuits) {
      const on = Boolean(pub.pick && pub.pick.tokenId === Number(c.tokenId) && pub.pick.cpu === Number(c.cpu));
      const state = !c.opened ? tr('需要开通容器') : c.hasIndex ? tr('已开通 · 有首页（会更新）') : tr('已开通 · 还没有首页');
      const b = mk('button', { type: 'button', className: 'pub-target' },
        mk('span', { className: 't', textContent: c.label }),
        mk('span', { className: 's', textContent: tr('#{tokenId}，处理器 {cpu}', { tokenId: c.tokenId, cpu: c.cpu }) }),
        mk('span', { className: 's', textContent: state }));
      b.setAttribute('aria-pressed', String(on));
      b.disabled = Boolean(pub.run) || pub.busy.has('inspect');
      b.addEventListener('click', () => chooseTarget(c));
      ul.append(mk('li', { className: 'pub-row' }, b));
    }
    box.append(ul);
    for (const s of t.skipped || []) box.append(note(tr('处理器 {cpu} 上的电路太多（最大编号 {maxId}），没有逐个检查；钱包在那里持有 {balance} 个电路，暂时不能从这里发布', { cpu: s.cpu, maxId: s.maxId, balance: s.balance }), 'warn'));
  }
  const CONFLICT_TEXT = {
    changed: tr('链上已有同名文件，内容不一样。只有 index.html 可以替换，请给这个文件改个名字（比如加上版本号），并改掉引用它的地方'),
    corrupt: tr('链上的同名文件分块异常，没法接着传。请给这个文件改个名字，并改掉引用它的地方'),
  };

  function renderPlan() {
    const sec = $('pub-plan-sec');
    const box = $('pub-plan');
    sec.hidden = !pub.pick || Boolean(pub.run) || Boolean(pub.result);
    box.textContent = '';
    if (sec.hidden) return;
    const p = pub.plan;
    const again = () => mk('div', { className: 'pub-actions' }, button(tr('重新检查'), () => inspectPick(), { busy: 'inspect' }));
    if (!p) { box.append(note(tr('正在检查 {label}：读取本地文件、对比链上已有的文件、估算 gas…', { label: pub.pick.label }))); return; }
    if (p.error) { box.append(note(p.error.message, 'bad'), again()); return; }
    if (p.stage === 'blocked') {
      box.append(note(tr('预检查没有通过，改好下面的问题后再检查：'), 'bad'), checkList(p.errors), again());
      return;
    }
    if (p.stage === 'conflicts') {
      box.append(note(tr('有 {n} 个文件和链上的同名文件冲突，不能发布：', { n: p.conflicts.length }), 'bad'));
      box.append(checkList(p.conflicts.map((c) => ({ level: 'error', text: tr('/{path}：{reason}', { path: c.path, reason: CONFLICT_TEXT[c.reason] || c.reason }) }))), again());
      return;
    }
    const c = p.counts;
    // 写明发布的是哪个文件夹、发到哪个网站：从残留记录继续时不会悄悄发成别的网站
    box.append(mk('p', { className: 'pub-banner', textContent: tr('将把当前文件夹 {root} 发布到 {label}', { root: pub.root || pub.url, label: p.label }) }));
    box.append(facts([
      [tr('网站'), p.label],
      [tr('文件'), tr('新上传 {create} 个，续传 {append} 个，复用 {reuse} 个，替换首页 {replace} 个', c)],
      [tr('上传'), tr('{txs} 笔交易，{size}', { txs: p.transactions, size: size(p.uploadBytes) })],
      [tr('开通费'), p.opened ? tr('容器已开通，不用再付') : coin(p.openFee, p.netKey, 'up'), '', p.opened ? '' : exact(p.openFee, p.netKey)],
      [tr('上传 gas（预估）'), tr('{amount}（单价 {gwei} gwei）', { amount: coin(p.uploadCost, p.netKey, 'up'), gwei: formatUnits(p.gasPrice, 9, 'up') }), '', exact(p.uploadCost, p.netKey)],
      [tr('合计（预估）'), coin(p.totalCost, p.netKey, 'up'), 'total', exact(p.totalCost, p.netKey)],
    ]));
    box.append(note(tr('不含你钱包自己发这几笔交易的手续费；Gas 单价上涨时充值会多一些，可能要多确认一次补充值，没用完的会退回')));
    if (p.indexChunks && p.indexChunks > 1) box.append(note(tr('首页有 {n} 块，要分 {n} 笔替换：更新期间网站会暂时打不开，传完就恢复。', { n: p.indexChunks }), 'warn'));
    if (!p.transactions) box.append(note(tr('链上的文件已经和本地一样，没有要上传的内容。')));
    const actions = mk('div', { className: 'pub-actions' },
      button(tr('开始发布'), () => startRun(p.id), { busy: 'run', primary: true, disabled: !p.id || !p.transactions }),
      button(tr('重新检查'), () => inspectPick(), { busy: 'inspect', link: true }));
    box.append(actions, note(tr('接下来钱包通常会请你确认 2 到 3 笔交易：开通容器（如果需要）、授权临时钱包 6 小时、充值上传用的 gas。剩下的 gas 发布完自动退回。')));
  }
  /** 钱包要确认的这一步签的是什么 */
  function walletStep(kind, run) {
    if (kind === 'open') return run.openFee ? tr('开通容器并支付开通费 {fee}', { fee: coin(run.openFee, run.netKey, 'up') }) : tr('开通容器并支付开通费');
    if (kind === 'grant') return tr('授权临时钱包上传 6 小时');
    if (kind === 'fund') return tr('给临时钱包充值上传用的 gas');
    return tr('一笔发布用的交易');
  }
  const WAIT_TEXT = { open: tr('正在等开通容器的交易确认…'), grant: tr('正在等授权的交易确认…'), fund: tr('正在等充值的交易确认…') };

  function runStepText(r) {
    if (r.stage === 'upload') return r.total ? tr('正在上传：第 {done} / {total} 笔，/{path}', { done: r.done, total: r.total, path: r.path || '' }) : tr('正在上传…');
    if (r.stage === 'verify') return r.total ? tr('正在核验链上的文件：{done} / {total}', { done: r.done, total: r.total }) : tr('正在核验链上的文件…');
    if (r.stage === 'refund') return tr('正在把剩下的 gas 退回持有人…');
    if (WAIT_TEXT[r.stage]) return WAIT_TEXT[r.stage];
    return tr('正在准备：检查上次留下的交易和链上的最新状态…');
  }

  /** 钱包确认的提示（role=alert）和步骤一行（aria-live）是固定的元素，只在内容变了时改，读屏不会每次重画都重读 */
  function setRunLines(walletText, stepText) {
    const w = $('pub-wallet');
    if (w.textContent !== walletText) w.textContent = walletText;
    w.hidden = !walletText;
    const s = $('pub-step');
    if (s.textContent !== stepText) s.textContent = stepText;
    s.hidden = !stepText;
  }

  function renderRun() {
    const sec = $('pub-run-sec');
    const box = $('pub-run');
    sec.hidden = !pub.run && !pub.result;
    box.textContent = '';
    const r = pub.run;
    if (!r) { setRunLines('', ''); if (pub.result) renderResult(box, pub.result); return; }
    setRunLines(r.wallet ? tr('请在浏览器的钱包扩展里确认：{step}', { step: walletStep(r.wallet, r) }) : '', r.wallet ? '' : runStepText(r));
    box.append(facts([[tr('网站'), r.label]]));
    const bar = mk('progress', { className: 'pub-bar' });
    bar.setAttribute('aria-label', tr('发布进度'));
    // 没有总数的步骤显示不确定的进度条
    if (!r.wallet && r.total) { bar.max = r.total; bar.value = r.done || 0; }
    box.append(bar);
    if (r.hash) box.append(note(tr('交易 {hash}', { hash: shortHex(r.hash) })));
    if (r.warn) box.append(note(r.warn, 'bad'));
    // 核验、退款开始以后一定做完，暂停不起作用
    if (r.stage === 'verify' || r.stage === 'refund') return;
    const actions = mk('div', { className: 'pub-actions' }, button(r.pausing ? tr('正在暂停…') : tr('暂停'), () => pausePublish(), { busy: 'pause', disabled: r.pausing }));
    actions.append(mk('span', { className: 'pub-note', textContent: tr('暂停会在当前这笔交易确认后生效，可能要等几分钟') }));
    box.append(actions);
  }
  /** 回到发布计划，按最新状态重新检查 */
  const recheck = () => { pub.result = null; inspectPick(); };

  /** 发布结束：成功、暂停或出错。暂停和出错时钱可能还在临时钱包里，给「继续发布」和「退款」（契约第 7 条） */
  function renderResult(box, res) {
    const actions = mk('div', { className: 'pub-actions' });
    const resume = () => button(tr('继续发布'), () => continueRun(res.id), { busy: 'run', primary: true });
    if (res.label) box.append(facts([[tr('网站'), res.label]]));
    if (res.paused) {
      box.append(mk('p', { className: 'pub-banner warn', role: 'status', textContent: tr('已暂停。没用完的 gas 还在临时钱包里，可以继续发布，也可以退款。') }));
      actions.append(resume());
    } else if (res.error) {
      const code = res.error.code;
      box.append(mk('p', { className: 'pub-banner bad', role: 'alert', textContent: res.error.message }));
      if (code === 'LATER' || code === 'PENDING_TIMEOUT' || code === 'WALLET_LOST') {
        if (code === 'WALLET_LOST') box.append(note(tr('钱包没有回应，交易可能已经发出。继续发布时会先到链上按最新状态检查，再决定从哪一步接着做。')));
        else box.append(note(tr('交易还没确认或节点还没同步，等一会再继续发布。')));
        actions.append(resume());
      } else if (code === 'WALLET_PENDING') {
        box.append(note(tr('钱包里还有一笔没确认的交易：请在钱包扩展里等它确认（或取消它），然后再继续发布。')));
        actions.append(resume());
      } else if (code === 'STATE_CHANGED') {
        actions.append(button(tr('重新检查'), recheck, { busy: 'inspect', primary: true }));
      } else if (code === 'USER_REJECTED') {
        actions.append(button(tr('重新开始'), recheck, { busy: 'inspect', primary: true }));
      } else {
        actions.append(button(tr('重新检查'), recheck, { busy: 'inspect' }));
      }
    } else {
      box.append(mk('p', { className: 'pub-banner ' + (res.verified ? 'ok' : 'warn'), role: 'status', textContent: res.verified ? tr('发布完成，链上的文件已经核验过') : tr('发布完成') }));
      box.append(facts([
        [tr('上传'), tr('{n} 笔交易', { n: res.uploaded })],
        [tr('复用'), tr('{n} 个文件和链上已有的一样，没有重传', { n: res.reused })],
        [tr('花费'), tr('{amount}（临时钱包付的 gas，不含开通费）', { amount: coin(res.spent, res.netKey, 'up') }), '', exact(res.spent, res.netKey)],
        [tr('退回'), coin(res.refunded, res.netKey), '', exact(res.refunded, res.netKey)],
      ]));
      if (!res.verified) box.append(note(res.reason === 'safe' ? tr('还没核验完（等安全区块超时），可以稍后重新打开网站检查') : tr('还没核验完，可以稍后重新打开网站检查'), 'warn'));
      if (res.dust) box.append(note(tr('临时钱包里剩下的零头不够付退款的手续费，留在了临时钱包里，可以在下面「放弃零头」'), 'warn'));
      if (res.url) actions.append(button(tr('打开网站'), () => openSite(res.url), { primary: true }));
      actions.append(button(tr('重新检查'), recheck, { busy: 'inspect', link: true }));
    }
    if ((res.paused || res.error) && canRefund(res)) actions.append(button(tr('退款'), () => refundLeft(res.netKey, res.container), { busy: 'refund:' + res.container }));
    box.append(actions);
  }
  /** 页面底部：上次没发完或没退干净的临时钱包（契约第 4 条） */
  function renderLeftovers() {
    const box = $('pub-leftovers');
    box.textContent = '';
    const l = pub.leftovers;
    const reload = () => button(tr('刷新'), () => loadLeftovers(), { busy: 'leftovers', link: true });
    if (!l) { box.append(note(tr('读取中…'))); return; }
    if (l.error) { box.append(note(l.error, 'bad'), reload()); return; }
    if (l.unavailable) { box.append(note(AVAIL_TEXT['no-encryption'], 'bad')); return; }
    const recs = l.records || [];
    if (!recs.length && !(l.broken || []).length && !(l.errors || []).length) box.append(note(tr('没有。每次发布都会新建一个临时钱包付上传的 gas，发完自动把剩下的退回持有人。')));
    const ul = mk('ul', { className: 'list' });
    for (const rec of recs) {
      const net = pubNet(rec.netKey);
      const flags = [];
      if (rec.pending) flags.push(tr('临时钱包有一笔交易在等确认'));
      if (rec.ownerPending) flags.push(tr('持有人有一笔交易在等确认'));
      const head = mk('div', { className: 'head' },
        mk('span', { className: 't', textContent: shortAddr(rec.container), title: rec.container }),
        mk('span', { className: 's', textContent: net ? net.name : rec.netKey }),
        mk('span', { textContent: coin(rec.balance, rec.netKey), title: exact(rec.balance, rec.netKey) }),
        mk('span', { className: 's', textContent: tr('持有人 {owner}', { owner: shortAddr(rec.owner) }), title: rec.owner }));
      const li = mk('li', { className: 'pub-left' }, head);
      head.firstChild.setAttribute('aria-label', tr('容器 {container}', { container: rec.container }));
      for (const f of flags) li.append(note(f));
      if (rec.decryptable === false) {
        li.append(note(tr('这个临时钱包无法解密（系统钥匙串可能已重置），里面的余额找不回来了'), 'bad'));
      } else {
        const busy = pub.busy.has('refund:' + rec.container) || pub.busy.has('discard:' + rec.container) || Boolean(pub.run);
        li.append(mk('div', { className: 'pub-actions' },
          button(tr('继续发布'), () => resumeLeft(rec), { disabled: busy || pub.busy.has('targets') }),
          button(tr('退款'), () => refundLeft(rec.netKey, rec.container), { disabled: busy }),
          button(tr('放弃零头'), () => discardLeft(rec.netKey, rec.container), { disabled: busy, link: true })));
      }
      ul.append(li);
    }
    if (recs.length) box.append(ul);
    if (recs.length) box.append(note(tr('「放弃零头」只用于余额不够付退款手续费的临时钱包，放弃前会再问一次。')));
    for (const b of l.broken || []) box.append(note(tr('{name} 上有一个临时钱包记录文件已损坏（{file}），里面的余额可能找不回来', { name: (pubNet(b.netKey) || {}).name || b.netKey, file: b.file }), 'warn'));
    for (const e of l.errors || []) box.append(note(tr('{name} 上的临时钱包读取失败：{message}', { name: (pubNet(e.netKey) || {}).name || e.netKey, message: e.message }), 'warn'));
    box.append(reload());
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
    closePages();
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
  for (const b of document.querySelectorAll('.examples button, .quickstart button')) {
    b.addEventListener('click', () => { closePages(); $('address').value = b.dataset.q; tb.invoke('submit', b.dataset.q); });
  }
  $('open-help').addEventListener('click', () => setHelp(true));
  $('help-close').addEventListener('click', () => setHelp(false));
  $('publish-close').addEventListener('click', () => openPublish(false));
  for (const b of document.querySelectorAll('#dir-view button')) {
    b.addEventListener('click', () => { dirView = b.dataset.view; localStorage.setItem('dirView', dirView); renderDirectory(); });
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
    // 发布页：钱包刚连上时读选好的链上的电路；断开时回到连接提示
    if (pub.open && was !== Boolean(wallet.ready)) {
      if (wallet.ready && pub.netKey && !pub.run) chooseNet(pub.netKey);
      else renderPublish();
    }
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
  // 本地预览的文件夹改了：页面会自动刷新，预检查结果也重新算
  tb.on('localChanged', () => { if (isLocal(active() && active().url)) { siteKey = ''; refreshSite(); } });
  tb.on('command', (name) => {
    if (name === 'focusAddress') focusAddress();
    else if (name === 'settings') setSettings(!settingsOpen);
    else if (name === 'help') setHelp(!helpOpen);
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
