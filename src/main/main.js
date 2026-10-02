// TapeBrowser 主进程：窗口、标签、tape:// 协议、钱包桥接、菜单。

import { app, BrowserWindow, protocol, session as electronSession, ipcMain, dialog, shell, net, Menu, nativeTheme, clipboard } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSettings } from './settings.js';
import { createRpcPool } from './rpc.js';
import { createChain } from './chain.js';
import { createSites } from './sites.js';
import { createTapeHandler } from './tape-protocol.js';
import { createBridgeServer } from './bridge-server.js';
import { createProviderHost, providerError } from './provider-host.js';
import { createTabs, originOf, ALLOWED } from './tabs.js';
import { createLibrary } from './library.js';
import { createContentStore } from './content-store.js';
import { createDirectory, QUICK_CHECK_EVERY } from './directory.js';
import { parseInput, parseHost, siteLabel, normalizePath } from './address.js';
import { describeRequest } from './describe.js';
import { NETWORKS, BSC, networkByArea, networkByKey } from './config.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PARTITION = 'persist:tape';

protocol.registerSchemesAsPrivileged([{
  scheme: 'tape',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

if (!app.requestSingleInstanceLock()) app.quit();

const settings = createSettings(join(app.getPath('userData'), 'settings.json'));
// 每条链一个节点池：自定义节点为空时用内置节点。net.fetch 走 Chromium 网络栈，遵守系统代理
const rpcUrls = (n) => (settings.rpcsOf(n.key).length ? settings.rpcsOf(n.key) : n.rpcs);
const rpcs = Object.fromEntries(NETWORKS.map((n) => [n.key, createRpcPool(() => rpcUrls(n), { fetchImpl: (url, init) => net.fetch(url, init) })]));
const contentStore = createContentStore(join(app.getPath('userData'), 'content-cache'));
const chains = Object.fromEntries(NETWORKS.map((n) => [n.key, createChain(rpcs[n.key], n)]));
const sites = createSites(chains, contentStore);
const directory = createDirectory({
  chains, sites, file: join(app.getPath('userData'), 'directory.json'),
  onChange: () => send('directory', directory.list()),
  onProgress: () => send('directoryStatus', directory.status()),
});
/** 后台刷新目录：到期才扫（完整扫描每天一次，快速检查每小时一次） */
function refreshDirectory(force = false) {
  directory.refresh({ force }).catch(() => { /* 失败状态已经通过 directoryStatus 显示 */ });
}
const library = createLibrary(join(app.getPath('userData'), 'library.json'), { onChange: () => pushLibrary() });

let win = null;
let tabs = null;
let tabSession = null;
let bridge = null;
let host = null;
let scanning = false;
// 外壳界面加载完成前，外部传入的链接先排队
let uiLoaded = false;
const pendingExternal = [];

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send('ui:' + ch, payload); };
const notify = (text, level = 'info') => send('notice', { text, level });
const pushLibrary = () => send('library', { history: library.history(), bookmarks: library.bookmarks() });

/** 当前标签加入或移出书签 */
function toggleBookmark() {
  const t = tabs?.active();
  if (!t?.url) return false;
  const on = library.toggleBookmark(t.url, t.title);
  notify(on ? `已加入书签：${t.title || t.url}` : '已移除书签', 'ok');
  return on;
}

function siteName(origin) {
  const m = /^tape:\/\/(.+)$/.exec(origin || '');
  const s = m && parseHost(m[1]);
  return s ? siteLabel(s.tokenId, s.cpu, s.area) : origin;
}
function walletView() {
  const s = bridge?.state || {};
  return { connected: Boolean(s.connected), ready: Boolean(s.ready), wallet: s.wallet || null, account: s.accounts?.[0] || null, chainId: s.chainId || null, bridgeUrl: bridge ? bridge.url() : null };
}

/** TapeBrowser 自己的确认弹窗：钱包扩展只看得到 127.0.0.1，看不到真正发请求的网站 */
async function confirm(req) {
  if (win?.isMinimized()) win.restore();
  win?.show();
  const name = siteName(req.origin);
  if (req.kind === 'connect') {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['连接', '拒绝'],
      defaultId: 0,
      cancelId: 1,
      message: `${name} 想连接你的钱包`,
      detail: `网站将看到地址 ${req.account}。\n之后每次签名或交易都会再次询问，并且需要在浏览器的钱包扩展里确认。\n\n来源：${req.origin}`,
    });
    return { ok: r.response === 0, remember: false };
  }
  const d = describeRequest(req.method, req.params);
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['去钱包确认', '拒绝'],
    defaultId: 0,
    cancelId: 1,
    message: `${name} 请求：${d.title}`,
    detail: `${d.body}\n\n来源：${req.origin}\n继续后请切换到浏览器，在钱包扩展里核对并确认。`,
    checkboxLabel: '本次运行期间不再询问这个网站（仍需在钱包里确认）',
    checkboxChecked: false,
  });
  return { ok: r.response === 0, remember: r.checkboxChecked };
}

function emit(origin, event, payload) {
  if (!tabs) return;
  for (const wc of tabs.byOrigin(origin)) {
    // payload 是函数时按网页自己的来源计算（chainChanged：每个网站所在的链可能不同）
    wc.send('eth:event', event, typeof payload === 'function' ? payload(originOf(wc.getURL())) : payload);
  }
}

const validRpc = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(x.hostname));
  } catch { return false; }
};

function registerIpc() {
  // 网页 → window.ethereum
  const tabOrigin = (e) => (tabs?.owns(e.sender) && e.senderFrame === e.sender.mainFrame ? originOf(e.senderFrame.url) : null);
  ipcMain.handle('eth:request', async (e, method, params) => {
    const origin = tabOrigin(e);
    if (!origin) return { ok: false, error: providerError(4100, '这个页面不能使用钱包') };
    try {
      return { ok: true, result: await host.handle(origin, method, params) };
    } catch (err) {
      return { ok: false, error: { code: Number(err?.code) || -32603, message: String(err?.message || err), data: err?.data } };
    }
  });
  ipcMain.handle('eth:initial', (e) => {
    const origin = tabOrigin(e);
    return origin ? host.initial(origin) : { chainId: BSC.chainIdHex, accounts: [] };
  });

  // 外壳界面
  const ui = (name, fn) => ipcMain.handle('ui:' + name, (e, ...args) => {
    if (!win || e.sender !== win.webContents) throw new Error('forbidden');
    return fn(...args);
  });
  ui('ready', () => { tabs.push(); send('wallet', walletView()); pushLibrary(); });
  ui('newTab', () => tabs.open());
  ui('closeTab', (id) => tabs.close(id));
  ui('activate', (id) => tabs.activate(id));
  ui('back', () => tabs.back());
  ui('forward', () => tabs.forward());
  ui('reload', () => tabs.reload());
  ui('stop', () => tabs.stop());
  ui('submit', (text) => submit(String(text || '')));
  ui('bounds', (b) => {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    tabs.setBounds({ x: n(b?.x), y: n(b?.y), width: n(b?.width), height: n(b?.height) });
  });
  ui('overlay', (on) => tabs.setOverlay(on));
  ui('settings', () => ({
    networks: NETWORKS.map((n) => ({ key: n.key, name: n.name, rpcUrls: settings.rpcsOf(n.key), defaultRpcs: [...n.rpcs] })),
    origins: settings.permittedOrigins().map((o) => ({ origin: o, name: siteName(o) })),
    version: app.getVersion(),
  }));
  ui('saveRpcs', (key, list) => {
    const n = networkByKey(key);
    if (!n) throw new Error('未知的网络');
    const urls = (Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter(Boolean);
    const bad = urls.filter((u) => !validRpc(u));
    if (bad.length) throw new Error('RPC 地址必须是 https://（本机节点可以用 http://127.0.0.1）：' + bad.join(', '));
    settings.setRpcs(n.key, urls.slice(0, 10));
    return true;
  });
  ui('revoke', (origin) => host.revoke(String(origin)));
  ui('openBridge', () => shell.openExternal(bridge.url()));
  ui('disconnectWallet', () => disconnectWallet());
  ui('find', (text, opts) => tabs.find(String(text || ''), { forward: opts?.forward !== false, again: Boolean(opts?.again) }));
  ui('stopFind', () => tabs.stopFind());
  ui('zoom', (dir) => tabs.zoom(Math.sign(Number(dir) || 0)));
  ui('toggleBookmark', () => toggleBookmark());
  ui('removeBookmark', (url) => library.removeBookmark(String(url)));
  ui('removeHistory', (url) => library.removeHistory(String(url)));
  ui('clearHistory', () => library.clearHistory());
  ui('siteInfo', async () => {
    const t = tabs.active();
    const m = /^tape:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(t?.url || '');
    const site = m && parseHost(m[1]);
    if (!site) return null;
    let path;
    try { path = normalizePath(m[2] || '/'); } catch { return null; }
    try { return await sites.describe(site.tokenId, site.cpu, path, site.area); } catch (e) { return { error: String(e?.message || e) }; }
  });
  ui('copy', (text) => { clipboard.writeText(String(text).slice(0, 1000)); return true; });
  ui('cacheUsage', () => contentStore.usage());
  ui('directory', () => ({ sites: directory.list(), status: directory.status() }));
  ui('scanDirectory', () => { refreshDirectory(true); return directory.status(); });
  ui('clearCache', () => contentStore.clear());
  ui('openUrl', (url, opts) => {
    url = String(url || '');
    if (!ALLOWED.test(url)) return;
    if (opts?.background) tabs.open(url, { background: true });
    else submit(url);
  });
}
/** 一组网站：第一个放进当前空白标签（或新开并切过去），其余在后台标签打开 */
function openSites(list) {
  list.forEach((s, i) => {
    if (i === 0) {
      if (tabs.activeIsBlank()) tabs.navigate(tabs.active().id, s.url);
      else tabs.open(s.url);
    } else tabs.open(s.url, { background: true });
  });
}

async function submit(text) {
  const q = parseInput(text);
  const active = tabs.active();
  switch (q.kind) {
    case 'empty': return;
    case 'site':
    case 'url':
      if (active) tabs.navigate(active.id, q.url); else tabs.open(q.url);
      return;
    case 'digits': {
      notify(`正在查找 ${q.digits} 的所有电路组合…`);
      try {
        const r = await sites.enumerateDigits(q.digits);
        const failed = failedText(r.failed);
        if (!r.sites.length) {
          notify((r.candidates.length ? `没有找到有首页的网站（检查了 ${r.candidates.join('、')}）` : `${q.digits} 没有合法的电路组合`) + failed, 'error');
          return;
        }
        if (r.sites.length === 1 && active) tabs.navigate(active.id, r.sites[0].url);
        else openSites(r.sites);
        notify(`找到 ${r.sites.length} 个网站：${r.sites.map((s) => s.label).join('、')}${failed}`, 'ok');
      } catch (e) {
        notify('查询失败：' + (e?.message || e), 'error');
      }
      return;
    }
    case 'wallet': return scanWallet(q.address);
    case 'bad': notify(q.message, 'error'); return;
    default:
      notify('无法识别。可以输入 42460、1888、4454.0、#4454@0、1.2.248（X Layer）、1.3.5（Base）、8888.tape、钱包地址 0x… 或网址', 'error');
  }
}

/** 部分链读取失败时附在提示后面 */
const failedText = (failed) => (failed?.length ? `；${failed.map((f) => `${f.network} 读取失败（${f.message}）`).join('，')}` : '');

async function scanWallet(address) {
  if (scanning) { notify('已经在扫描钱包，请稍候', 'error'); return; }
  scanning = true;
  try {
    // 三条链并行扫描，进度提示里带上链名
    const r = await sites.scanWallet(address, (p) => {
      const on = p.network ? `${p.network}：` : '';
      if (p.stage === 'cpus') notify(`${on}正在读取处理器列表…`);
      else if (p.stage === 'balances') notify(`${on}正在查询 ${p.total} 台处理器上的持有数量…`);
      else if (p.stage === 'ids') notify(`${on}处理器 ${p.cpu}：已扫描 ${p.done} / ${p.total} 个编号`);
      else if (p.stage === 'index') notify(`${on}找到 ${p.total} 枚电路，正在检查网站首页…`);
    });
    if (r.sites.length) openSites(r.sites);
    const skipped = r.skipped.length ? `；${r.skipped.map((s) => `${s.network} 处理器 ${s.cpu} 编号太多未扫描`).join('，')}` : '';
    const tail = skipped + failedText(r.failed);
    if (r.sites.length) notify(`钱包持有 ${r.circuits} 枚电路，打开了 ${r.sites.length} 个网站${tail}`, 'ok');
    else notify(`钱包持有 ${r.circuits} 枚电路，没有带 index.html 的网站${tail}`, 'error');
  } catch (e) {
    notify('扫描失败：' + (e?.message || e), 'error');
  } finally {
    scanning = false;
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // 键盘焦点可能在网页里，先把焦点拉回外壳界面
  const ui = (name) => () => { win?.webContents.focus(); send('command', name); };
  const template = [
    ...(isMac ? [{ role: 'appMenu', label: 'TapeBrowser' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新标签页', accelerator: 'CmdOrCtrl+T', click: () => { tabs.open(); ui('focusAddress')(); } },
        { label: '打开地址', accelerator: 'CmdOrCtrl+L', click: ui('focusAddress') },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => { const t = tabs.active(); if (t) tabs.close(t.id); } },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: '退出' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '查找…', accelerator: 'CmdOrCtrl+F', click: ui('find') },
        { label: '查找下一个', accelerator: 'CmdOrCtrl+G', click: ui('findNext') },
        { label: '查找上一个', accelerator: 'CmdOrCtrl+Shift+G', click: ui('findPrev') },
      ],
    },
    {
      label: '显示',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => tabs.reload() },
        { label: '后退', accelerator: 'CmdOrCtrl+[', click: () => tabs.back() },
        { label: '前进', accelerator: 'CmdOrCtrl+]', click: () => tabs.forward() },
        { type: 'separator' },
        { label: '下一个标签页', accelerator: 'Ctrl+Tab', click: () => tabs.cycle(1) },
        { label: '上一个标签页', accelerator: 'Ctrl+Shift+Tab', click: () => tabs.cycle(-1) },
        ...Array.from({ length: 9 }, (_, i) => ({ label: `标签页 ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`, visible: false, click: () => tabs.select(i) })),
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => tabs.zoom(0) },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => tabs.zoom(1) },
        // 不按 Shift 的 ⌘= 也能放大
        { label: '放大', accelerator: 'CmdOrCtrl+=', visible: false, click: () => tabs.zoom(1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => tabs.zoom(-1) },
        { type: 'separator' },
        { label: '网页开发者工具', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => tabs.devtools() },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '书签',
      submenu: [
        { label: '为当前网页添加/移除书签', accelerator: 'CmdOrCtrl+D', click: () => toggleBookmark() },
        { label: '书签与最近访问', accelerator: 'CmdOrCtrl+Shift+B', click: () => { tabs.open(); ui('focusAddress')(); } },
        { type: 'separator' },
        { label: '清除历史记录', click: () => { library.clearHistory(); notify('已清除历史记录', 'ok'); } },
      ],
    },
    {
      label: '钱包',
      submenu: [
        { label: '打开钱包桥接页面', click: () => shell.openExternal(bridge.url()) },
        { label: '断开钱包', click: () => disconnectWallet() },
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: ui('settings') },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 400,
    title: 'TapeBrowser',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: { preload: join(SRC, 'preload/ui.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  tabs = createTabs({
    win, session: tabSession, preload: join(SRC, 'preload/tab.cjs'), send, notify,
    onVisit: (url) => library.visit(url),
    onTitle: (url, title) => library.title(url, title),
  });
  win.on('closed', () => { tabs.closeAll(); tabs = null; win = null; uiLoaded = false; });
  uiLoaded = false;
  win.loadFile(join(SRC, 'ui/index.html'));
  win.webContents.once('did-finish-load', () => {
    uiLoaded = true;
    if (pendingExternal.length) for (const u of pendingExternal.splice(0)) openExternalTape(u);
    else tabs.open();
  });
}

/** 断开钱包：网页收到 accountsChanged([])；网站授权保留，重新连接后不用再确认 */
function disconnectWallet() {
  if (!bridge?.state.ready) { notify('没有连接钱包'); return; }
  bridge.disconnect();
  notify('已断开钱包', 'ok');
}

/** 其他程序（访达、终端 open、别的浏览器）点开的 tape:// 链接 */
function openExternalTape(raw) {
  const q = parseInput(raw);
  if (!tabs || !win || !uiLoaded) {
    pendingExternal.push(raw);
    if (app.isReady() && !win) createWindow();
    return;
  }
  if (q.kind === 'site') tabs.open(q.url);
  else { tabs.open(); submit(raw); }
  win.show();
}

app.on('open-url', (e, url) => { e.preventDefault(); if (app.isReady()) openExternalTape(url); else pendingExternal.push(url); });
app.on('second-instance', (_e, argv) => {
  const url = argv.find((a) => /^tape:\/\//i.test(a));
  if (url) openExternalTape(url);
  else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  // 网页标签里不出现 Electron / 应用名，避免被网站当成非常规浏览器
  app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|tapebrowser|TapeBrowser)\/\S+/g, '');
  app.setAboutPanelOptions({
    applicationName: 'TapeBrowser',
    applicationVersion: app.getVersion(),
    version: '',
    copyright: 'TapeKit DeWEB 浏览器 · 作者 x.com/boostbob',
    credits: '如果你觉得这个产品对你有用，可以支持我继续开发，钱包地址：\n0xdda434fe0281ec6bf4f74ea263504bf878d0ee56',
  });
  // 开发模式下 Dock 图标可能还是 Launch Services 缓存的 Electron 图标，直接设置一次
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(SRC, '../build/icon.png'));

  tabSession = electronSession.fromPartition(PARTITION);
  tabSession.protocol.handle('tape', createTapeHandler(sites));
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  tabSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  tabSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  bridge = createBridgeServer({ token: settings.get('bridgeToken'), port: settings.get('bridgePort'), staticDir: join(SRC, 'bridge') });
  const port = await bridge.start();
  if (port !== settings.get('bridgePort')) settings.set('bridgePort', port);
  host = createProviderHost({ bridge, rpcs, settings, openBridge: () => shell.openExternal(bridge.url()), confirm, emit });
  bridge.on('state', () => send('wallet', walletView()));

  registerIpc();
  buildMenu();
  if (app.isPackaged) app.setAsDefaultProtocolClient('tape');
  // Windows/Linux 双击链接时 URL 在 argv 里；mac 走 open-url（开发调试时也可以从命令行传）
  const argUrl = process.argv.find((a) => /^tape:\/\//i.test(a));
  if (argUrl) pendingExternal.push(argUrl);
  createWindow();

  app.on('activate', () => { if (!win) createWindow(); });

  // 启动稍等一会再扫，避免和首屏网页抢 RPC
  setTimeout(() => refreshDirectory(), 5000).unref?.();
  setInterval(() => refreshDirectory(), QUICK_CHECK_EVERY).unref?.();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { library.flush(); contentStore.flush(); bridge?.stop(); });
