// 标签管理：每个标签一个 WebContentsView，叠在外壳界面下方的内容区。
// 空白标签（新标签页）不建 view，由外壳界面画新标签页；它的缩放记在 blankZoom，外壳界面只缩放新标签页区块。

import { WebContentsView, shell, Menu, clipboard } from 'electron';

export const ALLOWED = /^(https?|tape):/i;

/** 网页 origin。tape:// 在 WHATWG URL 里是不透明 origin（"null"），这里自己拼 */
export function originOf(url) {
  try {
    const u = new URL(url);
    if (!/^(https?|tape):$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}

// Chrome 的缩放档位
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// onVisit(url)         主框架成功打开一个页面（HTTP 2xx/3xx）
// onTitle(url, title)  页面标题更新
// tr(text, vars) 界面文字翻译（见 i18n/i18n.cjs）
export function createTabs({ win, session, preload, send, notify, tr = (s) => s, onVisit = () => {}, onTitle = () => {} }) {
  const tabs = new Map();
  const order = [];
  let activeId = null;
  let seq = 0;
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  let overlay = false;
  let lastBackground = null;
  // 正在页内查找的标签
  let findId = null;

  const snapshot = (t) => ({
    id: t.id,
    title: t.title || (t.url ? t.url : tr('新标签页')),
    url: t.url,
    loading: t.loading,
    favicon: t.favicon,
    canGoBack: Boolean(t.view?.webContents.navigationHistory.canGoBack()),
    canGoForward: Boolean(t.view?.webContents.navigationHistory.canGoForward()),
    zoom: Math.round((t.view ? t.view.webContents.getZoomFactor() : t.blankZoom || 1) * 100),
  });

  function push() {
    send('tabs', { tabs: order.map((id) => snapshot(tabs.get(id))), activeId });
  }

  function layout() {
    for (const t of tabs.values()) {
      if (!t.view) continue;
      const show = t.id === activeId && !overlay;
      t.view.setVisible(show);
      if (show) t.view.setBounds(bounds);
    }
  }

  function contextMenu(t, params) {
    const wc = t.view.webContents;
    const items = [];
    if (params.linkURL && ALLOWED.test(params.linkURL)) {
      items.push({ label: tr('在新标签页打开链接'), click: () => open(params.linkURL, { background: true }) });
      items.push({ label: tr('复制链接'), click: () => clipboard.writeText(params.linkURL) });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) items.push({ role: 'cut', label: tr('剪切') }, { role: 'copy', label: tr('复制') }, { role: 'paste', label: tr('粘贴') }, { type: 'separator' });
    else if (params.selectionText) items.push({ role: 'copy', label: tr('复制') }, { type: 'separator' });
    items.push(
      { label: tr('后退'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: tr('前进'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: tr('重新加载'), click: () => wc.reload() },
      { type: 'separator' },
      { label: tr('检查元素'), click: () => wc.inspectElement(params.x, params.y) },
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  }

  function ensureView(t) {
    if (t.view) return t.view;
    const view = new WebContentsView({
      webPreferences: { session, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    t.view = view;
    view.setVisible(false);
    win.contentView.addChildView(view);
    const wc = view.webContents;

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (ALLOWED.test(url)) open(url, { background: disposition === 'background-tab' });
      else if (/^mailto:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    const guard = (e, url) => {
      if (ALLOWED.test(url)) return;
      e.preventDefault();
      if (/^mailto:/i.test(url)) shell.openExternal(url);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('did-start-loading', () => { t.loading = true; push(); });
    wc.on('did-stop-loading', () => { t.loading = false; push(); });
    wc.on('page-title-updated', (_e, title) => { t.title = title; onTitle(wc.getURL(), title); push(); });
    wc.on('page-favicon-updated', (_e, icons) => { t.favicon = icons.find((i) => /^(https?|tape|data):/.test(i)) || null; push(); });
    const onNav = (_e, url) => { t.url = url; t.favicon = t.favicon && originOf(t.favicon) === originOf(url) ? t.favicon : null; push(); };
    wc.on('did-navigate', (e, url, code) => {
      onNav(e, url);
      // 不存在的电路、404 之类的错误页不记入历史
      if (code >= 200 && code < 400) onVisit(url);
    });
    wc.on('zoom-changed', (_e, dir) => zoom(dir === 'in' ? 1 : -1, t.id));
    wc.on('found-in-page', (_e, r) => {
      if (r.finalUpdate && findId === t.id) send('findResult', { active: r.activeMatchOrdinal, matches: r.matches });
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) onNav(_e, url); });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) notify(tr('打开失败：{desc}（{url}）', { desc, url }), 'error');
    });
    wc.on('context-menu', (_e, params) => contextMenu(t, params));
    return view;
  }

  function open(url = null, { background = false } = {}) {
    const t = { id: ++seq, url: null, title: '', loading: false, favicon: null, view: null };
    tabs.set(t.id, t);
    // 连续在后台打开的标签按打开顺序排在当前标签后面
    const anchor = background && lastBackground && order.includes(lastBackground) ? lastBackground : activeId;
    const at = anchor ? order.indexOf(anchor) + 1 : order.length;
    order.splice(at, 0, t.id);
    if (!background || !activeId) { activeId = t.id; lastBackground = null; } else lastBackground = t.id;
    if (url) navigate(t.id, url);
    layout();
    push();
    return t.id;
  }

  function navigate(id, url) {
    const t = tabs.get(id);
    if (!t || !ALLOWED.test(url)) return;
    t.url = url;
    t.title = '';
    ensureView(t).webContents.loadURL(url).catch(() => { /* 失败由 did-fail-load 提示 */ });
    layout();
    push();
  }

  function close(id) {
    const t = tabs.get(id);
    if (!t) return;
    const i = order.indexOf(id);
    order.splice(i, 1);
    tabs.delete(id);
    if (t.view) {
      win.contentView.removeChildView(t.view);
      t.view.webContents.close();
    }
    if (findId === id) findId = null;
    if (activeId === id) activeId = order[Math.min(i, order.length - 1)] ?? null;
    if (!order.length) { open(); return; }
    layout();
    push();
  }

  function activate(id) {
    if (!tabs.has(id)) return;
    if (id !== activeId) stopFind();
    activeId = id;
    lastBackground = null;
    layout();
    push();
    tabs.get(id).view?.webContents.focus();
  }

  const active = () => tabs.get(activeId) || null;
  const wcOf = (id) => tabs.get(id ?? activeId)?.view?.webContents || null;

  /** 页内查找：again=true 跳到下一个/上一个匹配，false 表示开始新的查找 */
  function find(text, { forward = true, again = false } = {}) {
    const wc = wcOf();
    if (!wc || !text) { stopFind(); return; }
    if (findId !== activeId) stopFind();
    findId = activeId;
    // Electron 的 findNext=true 表示开始新的查找会话
    wc.findInPage(String(text).slice(0, 500), { forward, findNext: !again });
  }

  function stopFind() {
    const wc = findId !== null ? wcOf(findId) : null;
    findId = null;
    if (wc && !wc.isDestroyed()) wc.stopFindInPage('clearSelection');
  }

  /** dir: 1 放大，-1 缩小，0 恢复 100% */
  function zoom(dir, id = activeId) {
    const t = tabs.get(id);
    if (!t) return;
    const wc = wcOf(id);
    const cur = wc ? wc.getZoomFactor() : t.blankZoom || 1;
    let f = 1;
    if (dir > 0) f = ZOOM_STEPS.find((z) => z > cur + 0.001) ?? ZOOM_STEPS.at(-1);
    else if (dir < 0) f = [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001) ?? ZOOM_STEPS[0];
    // 新标签页：只记比例，外壳界面按它缩放新标签页区块；打开网站后网站从 100% 开始
    if (wc) wc.setZoomFactor(f); else t.blankZoom = f;
    push();
  }

  return {
    open,
    navigate,
    close,
    activate,
    active,
    activeIsBlank: () => !active()?.url,
    back: () => { const wc = wcOf(); if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); },
    forward: () => { const wc = wcOf(); if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); },
    reload: () => wcOf()?.reload(),
    stop: () => wcOf()?.stop(),
    devtools: () => wcOf()?.toggleDevTools(),
    find,
    stopFind,
    zoom,
    cycle(step) {
      if (!order.length) return;
      const i = order.indexOf(activeId);
      activate(order[(i + step + order.length) % order.length]);
    },
    select(n) { if (order[n]) activate(order[n]); },
    /** 窗口关闭前调用：WebContentsView 的 webContents 不会随窗口自动销毁 */
    closeAll() {
      for (const t of tabs.values()) t.view?.webContents.close();
      tabs.clear();
      order.length = 0;
    },
    setBounds(b) { bounds = b; layout(); },
    setOverlay(on) { overlay = Boolean(on); layout(); },
    /** 某个 webContents 是不是我们的标签 */
    owns: (wc) => [...tabs.values()].some((t) => t.view?.webContents === wc),
    /** 当前停在某个 origin 上的所有标签的 webContents */
    byOrigin(origin) {
      return [...tabs.values()].filter((t) => t.view && (origin === null || originOf(t.view.webContents.getURL()) === origin)).map((t) => t.view.webContents);
    },
    push,
  };
}
