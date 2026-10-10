// TapeBrowser 主进程：窗口、标签、tape:// 协议、钱包桥接、菜单。

import { app, BrowserWindow, protocol, session as electronSession, ipcMain, dialog, shell, net, Menu, nativeTheme, clipboard, safeStorage } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { watch, readdirSync } from 'node:fs';
import { createSettings } from './settings.js';
import { createRpcPool } from './rpc.js';
import { createChain } from './chain.js';
import { createSites } from './sites.js';
import { createTapeHandler } from './tape-protocol.js';
import { createLocalSites, isLocalUrl } from './local-site.js';
import { precheck } from './precheck.js';
import { audit as safetyAudit } from './safety.js';
import { createBridgeServer } from './bridge-server.js';
import { createProviderHost, providerError, homeNetwork } from './provider-host.js';
import { createTabs, originOf, ALLOWED } from './tabs.js';
import { createLibrary } from './library.js';
import { createContentStore } from './content-store.js';
import { createDirectory, QUICK_CHECK_EVERY } from './directory.js';
import { parseInput, parseHost, siteLabel, normalizePath } from './address.js';
import { createAnalyzer, formatUnits } from './risk.js';
import { createPageAudit } from './page-audit.js';
import { createBemBalances } from './bem.js';
import { prepareTip, parseBem } from './tip.js';
import { formatBem } from './bem.js';
import { NETWORKS, BSC, networkByArea, networkByKey, networkByChainId } from './config.js';
import { createPublishService } from './publish-service.js';
import { checkLatest, autoCheck } from './updates.js';
import { translateMessage, matchMessage, fail, NO_OPERATOR, NO_ENCRYPTION, NOT_LOCAL, BUSY } from './publish-errors.js';
import { createRequire } from 'node:module';
const i18n = createRequire(import.meta.url)('../i18n/i18n.cjs');

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PARTITION = 'persist:tape';

protocol.registerSchemesAsPrivileged([{
  scheme: 'tape',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

if (!app.requestSingleInstanceLock()) app.quit();

const settings = createSettings(join(app.getPath('userData'), 'settings.json'));
// 界面语言：设置里选的，或者跟随系统（app.getLocale 要等 ready 之后才准，先用环境变量猜，ready 后再定）
let lang = i18n.pick(settings.get('lang'), Intl.DateTimeFormat().resolvedOptions().locale);
let tr = i18n.create(lang);
// 每条链一个节点池：自定义节点为空时用内置节点。net.fetch 走 Chromium 网络栈，遵守系统代理
const rpcUrls = (n) => (settings.rpcsOf(n.key).length ? settings.rpcsOf(n.key) : n.rpcs);
const rpcs = Object.fromEntries(NETWORKS.map((n) => [n.key, createRpcPool(() => rpcUrls(n), { fetchImpl: (url, init) => net.fetch(url, init) })]));
const contentStore = createContentStore(join(app.getPath('userData'), 'content-cache'));
const chains = Object.fromEntries(NETWORKS.map((n) => [n.key, createChain(rpcs[n.key], n)]));
const sites = createSites(chains, contentStore);
// 本地预览：本机文件夹当成网站打开（tape://local-<id>/），开发者上链前看效果、做发布预检查
const localSites = createLocalSites();
const directory = createDirectory({
  chains, sites, file: join(app.getPath('userData'), 'directory.json'),
  onChange: () => { library.syncDirectory(directory.list()); send('directory', directory.list()); },
  onProgress: () => send('directoryStatus', directory.status()),
});
/** 后台刷新目录：到期才扫（完整扫描每周一次，增量检查每小时一次） */
function refreshDirectory(force = false) {
  directory.refresh({ force }).catch(() => { /* 失败状态已经通过 directoryStatus 显示 */ });
}
// 每个网站实际加载的链上文件、外部资源，以及上次同意签名时的文件快照
const audit = createPageAudit(settings.baselines);
// 代币符号和精度：按「链 + 合约」缓存，确认弹窗解读授权数额用
const tokenCache = new Map();
function tokenInfo(net, token) {
  const key = `${net.key}:${String(token).toLowerCase()}`;
  if (!tokenCache.has(key)) tokenCache.set(key, chains[net.key].tokenInfo(token).catch(() => { tokenCache.delete(key); return null; }));
  return tokenCache.get(key);
}
// 钱包在各条链上的 BEM 余额，工具栏钱包按钮旁显示
const bem = createBemBalances({ chains, networks: NETWORKS, onChange: (v) => send('bem', v) });
const library = createLibrary(join(app.getPath('userData'), 'library.json'), { onChange: () => pushLibrary() });

let win = null;
let tabs = null;
let tabSession = null;
let bridge = null;
let host = null;
// 发布到容器：整个应用只有这一个（阶段 3 契约第 6 条），bridge 建好之后创建
let publish = null;
let scanning = false;
// 外壳界面加载完成前，外部传入的链接先排队
let uiLoaded = false;
const pendingExternal = [];

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send('ui:' + ch, payload); };
const notify = (text, level = 'info') => send('notice', { text, level });
const pushLibrary = () => send('library', { history: library.history(), bookmarks: library.bookmarks() });

const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

/** 打开电路网站后记下当前持有人和首页；持有人和上次看到的不一样时提醒 */
async function observeSite(url) {
  const m = /^tape:\/\/([^/?#]+)/i.exec(url || '');
  const s = m && parseHost(m[1]);
  if (!s) return;
  let info;
  try { info = await sites.indexInfo(s.tokenId, s.cpu, s.area); } catch { return; }
  const change = library.observe(url, info);
  if (change) notify(tr('{0} 的持有人变了：{1} → {2}。网站内容现在由新持有人控制，连接钱包、签名前请留意。', { 0: siteLabel(s.tokenId, s.cpu, s.area), 1: short(change.from), 2: short(change.to) }), 'error');
}

/** 当前标签加入或移出书签 */
function toggleBookmark() {
  const t = tabs?.active();
  if (!t?.url) return false;
  const on = library.toggleBookmark(t.url, t.title);
  notify(on ? tr('已加入书签：{0}', { 0: t.title || t.url }) : tr('已移除书签'), 'ok');
  return on;
}

function siteName(origin) {
  const m = /^tape:\/\/(.+)$/.exec(origin || '');
  const s = m && parseHost(m[1]);
  if (s) return siteLabel(s.tokenId, s.cpu, s.area);
  return isLocalUrl(origin) ? tr('本地预览') : origin;
}
function walletView() {
  const s = bridge?.state || {};
  return { connected: Boolean(s.connected), ready: Boolean(s.ready), wallet: s.wallet || null, account: s.accounts?.[0] || null, chainId: s.chainId || null, bridgeUrl: bridge ? bridge.url() : null };
}

/** 不在链上的网站（普通网页、本地预览）在确认弹窗里的提醒；链上网站返回 null */
function offChainNote(origin) {
  if (isLocalUrl(origin)) return tr('⚠️ 这是本地预览，内容来自本机文件夹，还没有上链。');
  if (/^https?:/i.test(origin || '')) return tr('⚠️ 这个网站不在链上：内容来自 {host} 的服务器，TapeBrowser 无法校验它的代码是谁写的、有没有被改过。请核对网址。', { host: origin.replace(/^https?:\/\//, '') });
  return null;
}

/** TapeBrowser 自己的确认弹窗：钱包扩展只看得到 127.0.0.1，看不到真正发请求的网站 */
async function confirm(req) {
  if (win?.isMinimized()) win.restore();
  win?.show();
  const name = siteName(req.origin);
  if (req.kind === 'connect') {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [tr('连接'), tr('拒绝')],
      defaultId: 0,
      cancelId: 1,
      message: tr('{name} 想连接你的钱包', { name }),
      detail: [offChainNote(req.origin), tr('网站将看到地址 {account}。\n之后每次签名或交易都会再次询问，并且需要在浏览器的钱包扩展里确认。\n\n来源：{origin}', { account: req.account, origin: req.origin })].filter(Boolean).join('\n\n'),
    });
    return { ok: r.response === 0, remember: false };
  }
  // 解读请求：钱包当前在 TapeKit 支持的链上时，从链上读代币信息
  const net = bridge?.state.chainId ? networkByChainId(parseInt(bridge.state.chainId, 16)) : null;
  const analyzer = createAnalyzer({ tokenInfo: net ? (a) => tokenInfo(net, a) : null, tr: (...a) => tr(...a) });
  let d;
  try { d = await analyzer.analyze(req.method, req.params, { net }); } catch { d = { level: 'warn', title: req.method, lines: [], raw: '' }; }
  const code = audit.compare(req.origin);
  const danger = d.level === 'danger';
  // 勾选过「不再询问」的网站：普通操作直接交给钱包；高危操作、网站代码改过时仍然弹窗
  if (req.trusted && !danger && !code.changed.length) { audit.commit(req.origin); return { ok: true, remember: false }; }

  const parts = [];
  if (danger) parts.push(tr('⚠️ 高危操作'));
  const off = offChainNote(req.origin);
  if (off) parts.push(off);
  parts.push(...d.lines);
  if (code.changed.length) {
    parts.push('', tr('⚠️ 这个网站在你上次使用钱包之后改过代码：{files}', { files: code.changed.slice(0, 5).map((f) => '/' + f).join(tr('、')) + (code.changed.length > 5 ? tr(' 等 {n} 个文件', { n: code.changed.length }) : '') }));
    parts.push(tr('新代码可能和你之前用过的不一样，请确认这次请求是你自己发起的。'));
  }
  const ext = audit.externalOf(req.origin).filter((e) => e.risky);
  if (ext.length) parts.push('', tr('这个网站运行了不在链上的外部脚本或接口：{list}', { list: ext.slice(0, 3).map((e) => e.origin).join(tr('、')) + (ext.length > 3 ? tr(' 等 {n} 个', { n: ext.length }) : '') }));
  if (d.raw) parts.push('', d.raw);
  parts.push('', tr('来源：{origin}', { origin: req.origin }), tr('继续后请切换到浏览器，在钱包扩展里核对并确认。'));

  // 高危时默认按钮是「拒绝」，也不能勾选「不再询问」
  const buttons = danger ? [tr('拒绝'), tr('我了解风险，去钱包确认')] : [tr('去钱包确认'), tr('拒绝')];
  const r = await dialog.showMessageBox(win, {
    type: danger || code.changed.length ? 'error' : 'warning',
    buttons,
    defaultId: 0,
    cancelId: danger ? 0 : 1,
    message: tr('{name} 请求：{title}', { name, title: d.title }),
    detail: parts.join('\n'),
    ...(danger ? {} : { checkboxLabel: tr('本次运行期间不再询问这个网站（仍需在钱包里确认；高危操作和网站改过代码时仍会询问）'), checkboxChecked: false }),
  });
  const ok = danger ? r.response === 1 : r.response === 0;
  if (ok) audit.commit(req.origin);
  return { ok, remember: ok && !danger && Boolean(r.checkboxChecked) };
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
    if (!origin) return { ok: false, error: providerError(4100, tr('这个页面不能使用钱包')) };
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

  // 外壳界面：启动时同步取语言和英文字典（界面第一次渲染前就要用）
  ipcMain.on('ui:i18n', (e) => { e.returnValue = win && e.sender === win.webContents ? { lang, en: lang === 'en' ? i18n.en : {} } : { lang: 'zh', en: {} }; });
  // 外壳界面
  const ui = (name, fn) => ipcMain.handle('ui:' + name, (e, ...args) => {
    if (!win || e.sender !== win.webContents) throw new Error('forbidden');
    return fn(...args);
  });
  ui('ready', () => { tabs.push(); send('wallet', walletView()); send('bem', bem.view()); pushLibrary(); });
  // 打赏：用当前钱包把 BEM 直接转进当前网站的容器
  ui('tip', async (text) => {
    const t = tabs.active();
    const m = /^tape:\/\/([^/?#]+)/i.exec(t?.url || '');
    const target = m && parseHost(m[1]);
    if (!target) throw new Error(tr('只能打赏电路网站'));
    const net = networkByArea(target.area);
    const amount = parseBem(text, (...a) => tr(...a));
    if (!bridge?.state.ready) throw new Error(tr('请先连接钱包'));
    if (bridge.state.chainId !== net.chainIdHex) throw new Error(tr('钱包当前不在 {name} 上，请先点红色的钱包按钮切换', { name: net.name }));
    const account = bridge.state.accounts[0];
    const info = await sites.site(target.tokenId, target.cpu, target.area);
    const label = siteLabel(target.tokenId, target.cpu, target.area);
    // 余额读失败就交给 prepareTip 里的模拟去发现
    const balance = net.bem ? await chains[net.key].tokenBalance(net.bem, account).catch(() => null) : null;
    const prepared = await prepareTip({ rpc: rpcs[net.key], net, site: info, account, amount, balance, tr: (...a) => tr(...a) });
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [tr('去钱包确认'), tr('取消')],
      defaultId: 0,
      cancelId: 1,
      message: tr('打赏 {amount} BEM 给 {site}', { amount: formatBem(amount), site: label }),
      detail: tr('从你的钱包 {account} 转出 {amount} BEM，转进 {site} 的容器 {container}。\n只需支付 {name} 的网络 gas。\n\n打赏会公开记录在链上，转出后无法撤回。', { account, amount: formatBem(amount), site: label, container: info.container, name: net.name }),
    });
    if (r.response !== 0) return { ok: false };
    const hash = await bridge.request('eth_sendTransaction', [prepared.tx], originOf(t.url));
    notify(tr('已提交打赏 {amount} BEM 给 {site}，等待链上确认', { amount: formatBem(amount), site: label }), 'ok');
    setTimeout(() => { bem.refresh().catch(() => {}); }, 8000).unref?.();
    return { ok: true, hash };
  });
  ui('refreshBem', () => bem.refresh());
  // 钱包和当前网站不在同一条链上时，点钱包按钮请钱包切过去
  ui('switchChain', async () => {
    const origin = originOf(tabs.active()?.url || '');
    const net = homeNetwork(origin);
    if (!net) return 'none';
    notify(tr('正在请钱包切换到 {name}，请在浏览器的钱包扩展里确认…', { name: net.name }));
    try {
      const r = await host.switchChain(origin);
      if (r === 'switched') notify(tr('钱包已切换到 {name}', { name: net.name }), 'ok');
      return r;
    } catch (e) {
      notify(Number(e?.code) === 4001 ? tr('已取消切换') : tr('切换失败：{message}，可以在钱包里手动切到 {name}', { message: String(e?.message || e), name: net.name }), 'error');
      return 'failed';
    }
  });
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
    lang: settings.get('lang') || 'auto',
  }));
  // 切换界面语言：重建菜单、重新加载外壳界面（网页标签不受影响）
  ui('setLang', (value) => {
    const v = ['zh', 'en'].includes(value) ? value : 'auto';
    settings.set('lang', v === 'auto' ? null : v);
    lang = i18n.pick(settings.get('lang'), app.getLocale());
    tr = i18n.create(lang);
    buildMenu();
    win?.webContents.reload();
    return lang;
  });
  ui('saveRpcs', (key, list) => {
    const n = networkByKey(key);
    if (!n) throw new Error(tr('未知的网络'));
    const urls = (Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter(Boolean);
    const bad = urls.filter((u) => !validRpc(u));
    if (bad.length) throw new Error(tr('RPC 地址必须是 https://（本机节点可以用 http://127.0.0.1）：') + bad.join(', '));
    settings.setRpcs(n.key, urls.slice(0, 10));
    return true;
  });
  ui('revoke', (origin) => host.revoke(String(origin)));
  ui('openBridge', () => shell.openExternal(bridge.url()));
  // 在 TapeBrowser 的新标签里打开官网开通容器：网页里的签名照常经过桥接页交给钱包扩展，
  // 也能用上 TapeBrowser 的确认弹窗和风险解读
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
    if (isLocalUrl(t?.url)) return localInfo(t.url);
    const m = /^tape:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(t?.url || '');
    const site = m && parseHost(m[1]);
    if (!site) return null;
    let path;
    try { path = normalizePath(m[2] || '/'); } catch { return null; }
    try { return { ...(await sites.describe(site.tokenId, site.cpu, path, site.area)), seen: library.seenOf(t.url), external: audit.externalOf(originOf(t.url)) }; } catch (e) { return { error: String(e?.message || e) }; }
  });
  // 当前网站容器里的原生币和 BEM（网站信息面板打开时读一次）
  ui('siteAssets', async () => {
    const t = tabs.active();
    const m = /^tape:\/\/([^/?#]+)/i.exec(t?.url || '');
    const site = m && parseHost(m[1]);
    if (!site) return null;
    try { return { url: t.url, assets: await sites.containerAssets(site.tokenId, site.cpu, site.area) }; } catch (e) { return { url: t.url, error: String(e?.message || e) }; }
  });
  // 多节点交叉校验当前页面（网站信息面板和「链上」按钮用）
  ui('verifySite', async () => {
    const t = tabs.active();
    const m = /^tape:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(t?.url || '');
    const site = m && parseHost(m[1]);
    if (!site) return null;
    let path;
    try { path = normalizePath(m[2] || '/'); } catch { return null; }
    try { return { url: t.url, ...(await sites.verify(site.tokenId, site.cpu, path, site.area)) }; } catch (e) { return { url: t.url, status: 'error', message: String(e?.message || e) }; }
  });
  ui('copy', (text) => { clipboard.writeText(String(text).slice(0, 1000)); return true; });
  ui('cacheUsage', () => contentStore.usage());
  ui('directory', () => ({ sites: directory.list(), status: directory.status() }));
  ui('scanDirectory', () => { refreshDirectory(true); return directory.status(); });
  // DeWEB 应用卡片上的 logo / cover：外壳界面不走 tape:// 协议，读出来（校验过 sha256）转成 data: 网址
  ui('siteImage', async (url, kind) => {
    const m = /^tape:\/\/([^/]+)\/$/.exec(String(url));
    if (!m || (kind !== 'logo' && kind !== 'cover')) return null;
    try {
      const img = await directory.imageFor(m[1], kind);
      return img ? `data:${img.type};base64,${Buffer.from(img.bytes).toString('base64')}` : null;
    } catch { return null; }
  });
  ui('clearCache', () => contentStore.clear());
  ui('openLocal', () => openLocalFolder());
  // 安全体检：读当前网站的全部文件，静态分析它会对钱包做什么、有没有作恶特征
  ui('safetyCheck', () => safetyCheck(tabs.active()?.url));
  ui('revealLocal', () => { const root = localSites.rootOf(tabs.active()?.url); if (root) shell.openPath(root); });
  // 本地预览的卡片图片：预检查核对过格式和大小的才显示
  ui('localImage', async (kind) => {
    const t = tabs.active();
    const root = localSites.rootOf(t?.url);
    if (!root || (kind !== 'logo' && kind !== 'cover')) return null;
    const r = await localInfo(t.url);
    const img = r?.check?.card?.[kind];
    const bytes = img && await localSites.bytesOf(root, img.path);
    return bytes ? `data:image/${img.type};base64,${Buffer.from(bytes).toString('base64')}` : null;
  });
  ui('openUrl', (url, opts) => {
    url = String(url || '');
    if (!ALLOWED.test(url)) return;
    if (opts?.background) tabs.open(url, { background: true });
    else submit(url);
  });

  // 发布到容器：全部返回 { ok: true, value } 或 { error: { code, message } }，不 throw 给渲染进程。
  // 参数一律逐个挑出来再交给发布服务（不展开渲染进程传来的对象），服务里还会再核对一遍
  // fn 返回 CANCELLED 表示用户在确认框里取消了：返回 { ok: false, cancelled: true }，不包进 value
  const pub = (name, fn) => ui(name, async (...args) => {
    try {
      if (!publish) throw new Error(tr('发布服务还没准备好'));
      const value = await fn(...args);
      return value === CANCELLED ? { ok: false, cancelled: true } : { ok: true, value };
    } catch (e) {
      return { error: publishError(e) };
    }
  });
  // 退款 / 放弃零头：确认框开着或调用还没结束时再点，直接拒绝，不叠第二个确认框
  let confirming = false;
  const once = (fn) => async (...args) => {
    if (confirming) throw fail(BUSY, '正在处理另一个退款或放弃零头操作，请等它结束');
    confirming = true;
    try { return await fn(...args); } finally { confirming = false; }
  };
  const arg = (a) => (a && typeof a === 'object' && !Array.isArray(a) ? a : {});
  pub('publishAvailable', () => publish.available());
  pub('publishTargets', (netKey) => publish.targets({ netKey }));
  // 渲染进程不知道本地文件夹的真实路径：按当前本地预览标签的网址在主进程里找（契约第 2、3 条）
  pub('publishInspect', (args) => {
    const { url, netKey, tokenId, cpu } = arg(args);
    const root = localSites.rootOf(typeof url === 'string' ? url : tabs?.active()?.url);
    if (!root) throw fail(NOT_LOCAL, '这个文件夹没有在本地预览里打开过');
    return publish.inspect({ root, netKey, tokenId, cpu });
  });
  pub('publishRun', (id) => publish.run({ id }));
  pub('publishPause', (id) => publish.pause({ id }));
  pub('publishRefund', once(async (args) => {
    const { netKey, container } = arg(args);
    const rec = await leftoverOf(netKey, container);
    const net = networkByKey(netKey);
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [tr('退款'), tr('取消')],
      defaultId: 0,
      cancelId: 1,
      message: tr('把临时钱包里的余额退回持有人？'),
      detail: tr('临时钱包 {address} 里现在有 {amount} {currency}，扣掉转账手续费后全部退回持有人地址 {owner}。\n退款由临时钱包自己签名，不需要在钱包里确认。', {
        address: rec.address, amount: formatUnits(rec.balance), currency: net.currency, owner: rec.owner,
      }),
    });
    if (r.response !== 0) return CANCELLED;
    return publish.refund({ netKey, container });
  }));
  pub('publishDiscard', once(async (args) => {
    const { netKey, container } = arg(args);
    const rec = await leftoverOf(netKey, container);
    const net = networkByKey(netKey);
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [tr('取消'), tr('放弃这笔零头')],
      defaultId: 0,
      cancelId: 0,
      message: tr('放弃临时钱包里的零头？'),
      detail: tr('临时钱包 {address} 里只剩 {amount} {currency}，不够付退回 {owner} 的转账手续费，所以退不出来。\n放弃后会删掉这个临时钱包，这笔钱永久拿不回来。', {
        address: rec.address, amount: formatUnits(rec.balance), currency: net.currency, owner: rec.owner,
      }),
    });
    if (r.response !== 1) return CANCELLED;
    return publish.discardDust({ netKey, container });
  }));
  // 每条链读取出错的 message 也按错误码翻译，和其他发布错误一样（界面直接显示）
  pub('publishLeftovers', async () => {
    const l = await publish.leftovers();
    return l.errors ? { ...l, errors: l.errors.map((e) => ({ ...e, message: publishError(e).message })) } : l;
  });
}

const CANCELLED = Symbol('cancelled');

/**
 * 发布出错 → 给渲染进程的 { code, message }：带 code 的按 PUBLISH_MESSAGES 翻译；
 * 不带 code 的能对上 PUBLISH_MESSAGES 也照样翻译，对不上（节点故障之类）再套一层「发布出错」
 */
function publishError(e) {
  const raw = String(e?.message || e);
  const code = e?.code && typeof e.code === 'string' ? e.code : null;
  const message = code || matchMessage(raw) ? translateMessage(raw, (...a) => tr(...a)) : tr('发布出错：{0}', { 0: raw });
  return { code, message };
}

/**
 * 启动时的残留提示（契约第 4 条）：钥匙串不可用、私钥解不开、记录文件损坏、还有余额或在途交易分开说。
 * 外壳界面只有一个提示位，后来的会盖掉先来的：合成一条，有一项是错误就按错误显示
 */
function noticeLeftovers(l) {
  const parts = [];
  let level = 'info';
  if (l?.unavailable) {
    // 从没发布过（目录里没有文件）就不提：不能发布的提示留给发布页
    if (hasPublishFiles()) { parts.push(tr('这台电脑无法安全保存临时钱包，暂时不能发布')); level = 'error'; }
  } else if (l) {
    for (const e of l.errors ?? []) console.error('publish leftovers:', e.netKey, e.code, e.message);
    const lost = l.records.filter((r) => r.decryptable === false).length;
    const rest = l.records.length - lost;
    if (lost) { parts.push(tr('有 {n} 个临时钱包无法解密（系统钥匙串可能已重置），里面的余额找不回来了', { n: lost })); level = 'error'; }
    if (l.broken?.length) { parts.push(tr('有 {n} 个临时钱包记录文件已损坏，里面的余额可能找不回来', { n: l.broken.length })); level = 'error'; }
    if (rest) parts.push(tr('有 {n} 个临时钱包里还有余额或在途交易，可以在发布页里继续发布或退款', { n: rest }));
  }
  if (!parts.length) return;
  // 外壳界面还没加载完时 notice 会丢：等它加载完再发
  const show = () => notify(parts.join(' '), level);
  if (uiLoaded) show(); else win?.webContents.once('did-finish-load', show);
}

/** userData/publish 下有没有任何文件（临时钱包记录） */
function hasPublishFiles() {
  try {
    return readdirSync(join(app.getPath('userData'), 'publish'), { recursive: true, withFileTypes: true }).some((d) => d.isFile());
  } catch { return false; }
}

/** 退款、放弃零头前确认用的残留记录：按链和容器在 leftovers() 里找，找不到就拒绝（不凭渲染进程传来的地址弹窗） */
async function leftoverOf(netKey, container) {
  const l = await publish.leftovers();
  if (l.unavailable) throw fail(NO_ENCRYPTION, '这台电脑无法安全保存临时钱包，暂时不能发布');
  const rec = typeof container === 'string' && l.records.find((r) => r.netKey === netKey && r.container.toLowerCase() === container.toLowerCase());
  if (!rec || !networkByKey(netKey)) throw fail(NO_OPERATOR, '没有这个容器的临时钱包');
  return rec;
}
// 本地预览的文件夹监听：root → watcher。文件一改，打开这个文件夹的标签自动刷新
const watchers = new Map();

/** 选一个本机文件夹（不传 dir 时弹出选择框），在标签里按 tape:// 规则打开 */
async function openLocalFolder(dir = null) {
  if (!dir) {
    const r = await dialog.showOpenDialog(win, { title: tr('打开本地文件夹预览'), buttonLabel: tr('预览'), properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return;
    dir = r.filePaths[0];
  }
  let site;
  try { site = await localSites.add(dir); } catch (e) { notify(tr('打不开这个文件夹：') + (e?.message || e), 'error'); return; }
  watchLocal(site);
  if (tabs.activeIsBlank()) tabs.navigate(tabs.active().id, site.url); else tabs.open(site.url);
  notify(tr('本地预览：{root}。文件改动后会自动刷新；点地址栏左边的「本地」查看发布预检查', { root: site.root }), 'ok');
}

function watchLocal({ root, url }) {
  if (watchers.has(root)) return;
  let timer = null;
  try {
    const w = watch(root, { recursive: true }, (_e, name) => {
      // 隐藏文件（.git 等）的变化不刷新
      if (name && String(name).split(/[\\/]/).some((s) => s.startsWith('.'))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        localChecks.delete(root);
        for (const wc of tabs?.byOrigin(originOf(url)) || []) wc.reload();
        send('localChanged', originOf(url));
      }, 300);
    });
    w.on('error', () => { w.close(); watchers.delete(root); });
    watchers.set(root, w);
  } catch { /* 不支持监听时只是不自动刷新 */ }
}

// 预检查结果按文件夹缓存，文件改动后清掉
const localChecks = new Map();

/** 本地预览标签的网站信息：文件夹、首页和发布预检查 */
async function localInfo(url) {
  const root = localSites.rootOf(url);
  if (!root) return { local: true, error: tr('这个本地文件夹没有在本次运行中打开，请重新选择') };
  const origin = originOf(url);
  // 外部资源每次都按当前页面实际加载的算，不缓存
  const external = audit.externalOf(origin);
  try {
    let listing = localChecks.get(root);
    if (!listing) localChecks.set(root, (listing = await localSites.list(root)));
    const check = await precheck({ ...listing, read: (p) => localSites.bytesOf(root, p), external, tr: (...a) => tr(...a) });
    return { local: true, root, label: tr('本地预览'), external, check };
  } catch (e) {
    return { local: true, root, error: String(e?.message || e) };
  }
}

// 安全体检最多读多少个文件、多少字节：太大的网站只体检一部分，报告里写明
const AUDIT_MAX_FILES = 400;
const AUDIT_MAX_BYTES = 24 * 1024 * 1024;
const RECENT = 24 * 60 * 60;

/** 安全体检当前标签的网站（链上网站读整个容器，本地预览读文件夹）。返回报告，或 {error} */
async function safetyCheck(url) {
  const external = audit.externalOf(originOf(url || ''));
  const t0 = Date.now();
  try {
    if (isLocalUrl(url)) {
      const root = localSites.rootOf(url);
      if (!root) return { url, error: tr('这个本地文件夹没有在本次运行中打开，请重新选择') };
      const listing = await localSites.list(root);
      const r = await safetyAudit({ files: listing.files, read: (p) => localSites.bytesOf(root, p), external, tr: (...a) => tr(...a) });
      return { url, local: true, ...r, context: [], ms: Date.now() - t0 };
    }
    const m = /^tape:\/\/([^/?#]+)/i.exec(url || '');
    const s = m && parseHost(m[1]);
    if (!s) return { url, error: tr('只能体检电路网站和本地预览') };
    const net = networkByArea(s.area);
    const all = await sites.siteFiles(s.tokenId, s.cpu, s.area);
    if (!all.site.exists || !all.site.opened) return { url, error: tr('这个电路没有开通容器，没有可体检的文件') };
    // 按大小从小到大读，超过上限的列进「没检查」
    const files = [];
    const extraSkipped = [];
    let bytes = 0;
    for (const f of [...all.files].sort((a, b) => a.size - b.size)) {
      if (files.length >= AUDIT_MAX_FILES || bytes + f.size > AUDIT_MAX_BYTES) { extraSkipped.push(f.path); continue; }
      files.push(f);
      bytes += f.size;
    }
    if (all.total > all.files.length) extraSkipped.push(tr('（容器里还有 {n} 个文件没有列出）', { n: all.total - all.files.length }));
    const r = await safetyAudit({
      files, read: all.read, external, extraSkipped, tr: (...a) => tr(...a),
      hasCode: (list) => chains[net.key].hasCode(list),
    });
    // 链上背景：持有人最近换过、网站刚更新过
    const context = [];
    const seen = library.seenOf(url);
    if (seen?.prevOwner) context.push({ level: 'warn', text: tr('这个网站换过持有人（上一任 {prev}），现在的内容由新持有人控制', { prev: seen.prevOwner }) });
    const newest = all.files.reduce((x, f) => Math.max(x, f.updatedAt || 0), 0);
    if (newest && Date.now() / 1000 - newest < RECENT) context.push({ level: 'warn', text: tr('网站在 24 小时内更新过文件。如果链接是别人刚发给你的，要多留意') });
    context.push({ level: 'info', text: tr('持有人 {owner}，{network}，共 {n} 个文件', { owner: all.site.owner, network: net.name, n: all.total }) });
    return { url, ...r, context, ms: Date.now() - t0 };
  } catch (e) {
    return { url, error: String(e?.message || e) };
  }
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
      notify(tr('正在查找 {digits} 的所有电路组合…', { digits: q.digits }));
      try {
        const r = await sites.enumerateDigits(q.digits);
        const failed = failedText(r.failed);
        if (!r.sites.length) {
          notify((r.candidates.length ? tr('没有找到有首页的网站（检查了 {0}）', { 0: r.candidates.join(tr('、')) }) : tr('{digits} 没有合法的电路组合', { digits: q.digits })) + failed, 'error');
          return;
        }
        if (r.sites.length === 1 && active) tabs.navigate(active.id, r.sites[0].url);
        else openSites(r.sites);
        notify(tr('找到 {length} 个网站：{0}{failed}', { length: r.sites.length, 0: r.sites.map((s) => s.label).join(tr('、')), failed }), 'ok');
      } catch (e) {
        notify(tr('查询失败：') + (e?.message || e), 'error');
      }
      return;
    }
    case 'wallet': return scanWallet(q.address);
    case 'bad': notify(q.message, 'error'); return;
    default:
      notify(tr('无法识别。可以输入 42460、1888、4454.0、#4454@0、1.2.248（X Layer）、1.3.5（Base）、8888.tape、钱包地址 0x… 或网址'), 'error');
  }
}

/** 部分链读取失败时附在提示后面 */
const failedText = (failed) => (failed?.length ? tr('；{0}', { 0: failed.map((f) => tr('{network} 读取失败（{message}）', { network: f.network, message: f.message })).join(tr('，')) }) : '');

async function scanWallet(address) {
  if (scanning) { notify(tr('已经在扫描钱包，请稍候'), 'error'); return; }
  scanning = true;
  try {
    // 三条链并行扫描，进度提示里带上链名
    const r = await sites.scanWallet(address, (p) => {
      const on = p.network ? tr('{network}：', { network: p.network }) : '';
      if (p.stage === 'cpus') notify(tr('{on}正在读取处理器列表…', { on }));
      else if (p.stage === 'balances') notify(tr('{on}正在查询 {total} 台处理器上的持有数量…', { on, total: p.total }));
      else if (p.stage === 'ids') notify(tr('{on}处理器 {cpu}：已扫描 {done} / {total} 个编号', { on, cpu: p.cpu, done: p.done, total: p.total }));
      else if (p.stage === 'index') notify(tr('{on}找到 {total} 枚电路，正在检查网站首页…', { on, total: p.total }));
    });
    if (r.sites.length) openSites(r.sites);
    const skipped = r.skipped.length ? tr('；{0}', { 0: r.skipped.map((s) => tr('{network} 处理器 {cpu} 编号太多未扫描', { network: s.network, cpu: s.cpu })).join(tr('，')) }) : '';
    const tail = skipped + failedText(r.failed);
    if (r.sites.length) notify(tr('钱包持有 {circuits} 枚电路，打开了 {length} 个网站{tail}', { circuits: r.circuits, length: r.sites.length, tail }), 'ok');
    else notify(tr('钱包持有 {circuits} 枚电路，没有带 index.html 的网站{tail}', { circuits: r.circuits, tail }), 'error');
  } catch (e) {
    notify(tr('扫描失败：') + (e?.message || e), 'error');
  } finally {
    scanning = false;
  }
}

const AUTHOR_URL = 'https://x.com/boostbob';
const DONATE_ADDRESS = '0xdda434fe0281ec6bf4f74ea263504bf878d0ee56';
const REPO = 'github.com/trytotapeout/TapeBrowser';

/** 关于：系统的关于面板只能显示纯文本，链接点不了，所以用自己的弹窗，按钮打开作者主页、源代码仓库、复制钱包地址 */
async function showAbout() {
  const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'none',
    // 打包后 build/ 不在应用里，mac 会自动用应用图标；开发模式下用仓库里的图标
    ...(app.isPackaged ? {} : { icon: join(SRC, '../build/icon.png') }),
    title: tr('关于 TapeBrowser'),
    message: `TapeBrowser ${app.getVersion()}`,
    detail: tr('TapeKit DeWEB 浏览器 · 作者 x.com/boostbob\n源代码：{REPO}\n\n如果你觉得这个产品对你有用，可以支持我继续开发，钱包地址：\n{DONATE_ADDRESS}', { REPO, DONATE_ADDRESS }),
    buttons: [tr('好'), tr('打开 x.com/boostbob'), tr('打开 GitHub'), tr('复制钱包地址')],
    defaultId: 0,
    cancelId: 0,
  });
  if (r.response === 1) shell.openExternal(AUTHOR_URL);
  else if (r.response === 2) shell.openExternal('https://' + REPO);
  else if (r.response === 3) { clipboard.writeText(DONATE_ADDRESS); notify(tr('已复制钱包地址'), 'ok'); }
}

/** 检查更新：只提示，打开 GitHub 发布页让用户自己下载。manual 是从菜单点的：已是最新、出错也要告诉用户 */
let checkingUpdate = false;
async function checkForUpdates(manual) {
  if (checkingUpdate) return;
  checkingUpdate = true;
  try {
    const fetchImpl = (url, init) => net.fetch(url, init);
    const current = app.getVersion();
    const r = manual ? await checkLatest({ current, fetchImpl }) : await autoCheck({ current, fetchImpl, settings });
    const parent = win && !win.isDestroyed() ? win : undefined;
    if (r.status === 'new') {
      const d = await dialog.showMessageBox(parent, {
        type: 'info',
        title: tr('检查 TapeBrowser 更新'),
        message: tr('TapeBrowser {version} 已发布', { version: r.version }),
        detail: tr('你现在用的是 {current}。到 GitHub 发布页下载新版本，安装后覆盖旧版即可，书签和设置都会保留。', { current }),
        buttons: [tr('去下载'), tr('以后再说'), tr('跳过这个版本')],
        defaultId: 0,
        cancelId: 1,
      });
      if (d.response === 0) shell.openExternal(r.url);
      else if (d.response === 2) settings.set('updateSkip', r.version);
    } else if (manual && r.status === 'latest') {
      await dialog.showMessageBox(parent, { type: 'info', title: tr('检查 TapeBrowser 更新'), message: tr('已是最新版本 {current}', { current }), buttons: [tr('好')] });
    } else if (r.status === 'error') {
      console.error('update check:', r.message);
      if (manual) await dialog.showMessageBox(parent, { type: 'warning', title: tr('检查 TapeBrowser 更新'), message: tr('检查更新失败'), detail: r.message, buttons: [tr('好')] });
    }
  } finally {
    checkingUpdate = false;
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // 键盘焦点可能在网页里，先把焦点拉回外壳界面
  const ui = (name) => () => { win?.webContents.focus(); send('command', name); };
  const template = [
    ...(isMac ? [{
      label: 'TapeBrowser',
      submenu: [
        { label: tr('关于 TapeBrowser'), click: () => showAbout() },
        { label: tr('检查更新…'), click: () => checkForUpdates(true) },
        { type: 'separator' },
        { role: 'services', label: tr('服务') },
        { type: 'separator' },
        { role: 'hide', label: tr('隐藏 TapeBrowser') },
        { role: 'hideOthers', label: tr('隐藏其他') },
        { role: 'unhide', label: tr('全部显示') },
        { type: 'separator' },
        { role: 'quit', label: tr('退出 TapeBrowser') },
      ],
    }] : []),
    {
      label: tr('文件'),
      submenu: [
        { label: tr('新标签页'), accelerator: 'CmdOrCtrl+T', click: () => { tabs.open(); ui('focusAddress')(); } },
        { label: tr('打开地址'), accelerator: 'CmdOrCtrl+L', click: ui('focusAddress') },
        { label: tr('打开本地文件夹预览…'), accelerator: 'CmdOrCtrl+O', click: () => openLocalFolder() },
        { label: tr('关闭标签页'), accelerator: 'CmdOrCtrl+W', click: () => { const t = tabs.active(); if (t) tabs.close(t.id); } },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: tr('退出') }]),
      ],
    },
    {
      label: tr('编辑'),
      submenu: [
        { role: 'undo', label: tr('撤销') },
        { role: 'redo', label: tr('重做') },
        { type: 'separator' },
        { role: 'cut', label: tr('剪切') },
        { role: 'copy', label: tr('复制') },
        { role: 'paste', label: tr('粘贴') },
        { role: 'selectAll', label: tr('全选') },
        { type: 'separator' },
        { label: tr('查找…'), accelerator: 'CmdOrCtrl+F', click: ui('find') },
        { label: tr('查找下一个'), accelerator: 'CmdOrCtrl+G', click: ui('findNext') },
        { label: tr('查找上一个'), accelerator: 'CmdOrCtrl+Shift+G', click: ui('findPrev') },
      ],
    },
    {
      label: tr('显示'),
      submenu: [
        { label: tr('重新加载'), accelerator: 'CmdOrCtrl+R', click: () => tabs.reload() },
        { label: tr('后退'), accelerator: 'CmdOrCtrl+[', click: () => tabs.back() },
        { label: tr('前进'), accelerator: 'CmdOrCtrl+]', click: () => tabs.forward() },
        { type: 'separator' },
        { label: tr('下一个标签页'), accelerator: 'Ctrl+Tab', click: () => tabs.cycle(1) },
        { label: tr('上一个标签页'), accelerator: 'Ctrl+Shift+Tab', click: () => tabs.cycle(-1) },
        ...Array.from({ length: 9 }, (_, i) => ({ label: tr('标签页 {0}', { 0: i + 1 }), accelerator: `CmdOrCtrl+${i + 1}`, visible: false, click: () => tabs.select(i) })),
        { type: 'separator' },
        { label: tr('实际大小'), accelerator: 'CmdOrCtrl+0', click: () => tabs.zoom(0) },
        { label: tr('放大'), accelerator: 'CmdOrCtrl+Plus', click: () => tabs.zoom(1) },
        // 不按 Shift 的 ⌘= 也能放大
        { label: tr('放大'), accelerator: 'CmdOrCtrl+=', visible: false, click: () => tabs.zoom(1) },
        { label: tr('缩小'), accelerator: 'CmdOrCtrl+-', click: () => tabs.zoom(-1) },
        { type: 'separator' },
        { label: tr('网页开发者工具'), accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => tabs.devtools() },
        { role: 'togglefullscreen', label: tr('全屏') },
      ],
    },
    {
      label: tr('书签'),
      submenu: [
        { label: tr('为当前网页添加/移除书签'), accelerator: 'CmdOrCtrl+D', click: () => toggleBookmark() },
        { label: tr('书签与最近访问'), accelerator: 'CmdOrCtrl+Shift+B', click: () => { tabs.open(); ui('focusAddress')(); } },
        { type: 'separator' },
        { label: tr('清除历史记录'), click: () => { library.clearHistory(); notify(tr('已清除历史记录'), 'ok'); } },
      ],
    },
    {
      label: tr('钱包'),
      submenu: [
        { label: tr('打开钱包桥接页面'), click: () => shell.openExternal(bridge.url()) },
        { label: tr('断开钱包'), click: () => disconnectWallet() },
        { label: tr('设置'), accelerator: 'CmdOrCtrl+,', click: ui('settings') },
      ],
    },
    { role: 'windowMenu', label: tr('窗口') },
    {
      label: tr('帮助'),
      role: 'help',
      submenu: [
        { label: tr('使用帮助'), click: ui('help') },
        // Windows、Linux 没有应用菜单，关于放在帮助里
        ...(isMac ? [] : [{ type: 'separator' }, { label: tr('检查更新…'), click: () => checkForUpdates(true) }, { label: tr('关于 TapeBrowser'), click: () => showAbout() }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 400,
    // 先不显示，最大化以后再显示，免得启动时窗口闪一下再变大
    show: false,
    title: 'TapeBrowser',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: { preload: join(SRC, 'preload/ui.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // 启动时铺满屏幕（不是全屏，菜单栏和 Dock 还在）；还原后回到上面的 1280×820
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  tabs = createTabs({
    win, session: tabSession, preload: join(SRC, 'preload/tab.cjs'), send, notify, tr: (...a) => tr(...a),
    onVisit: (url) => { library.visit(url); observeSite(url); },
    onNavigate: (url) => { const o = originOf(url); if (o) audit.reset(o); },
    onTitle: (url, title) => library.title(url, title),
  });
  win.on('closed', () => { tabs.closeAll(); tabs = null; win = null; uiLoaded = false; });
  uiLoaded = false;
  win.loadFile(join(SRC, 'ui/index.html'));
  win.webContents.once('did-finish-load', () => {
    uiLoaded = true;
    // 命令行 --preview <文件夹>：启动后直接打开本地预览（npm start -- --preview dist）
    const pi = process.argv.indexOf('--preview');
    const previewDir = pi > 0 ? process.argv[pi + 1] : null;
    if (pendingExternal.length) for (const u of pendingExternal.splice(0)) openExternalTape(u);
    else if (!previewDir) tabs.open();
    if (previewDir) { if (!tabs.active()) tabs.open(); openLocalFolder(previewDir); }
  });
}

/** 断开钱包：网页收到 accountsChanged([])；网站授权保留，重新连接后不用再确认 */
function disconnectWallet() {
  if (!bridge?.state.ready) { notify(tr('没有连接钱包')); return; }
  bridge.disconnect();
  notify(tr('已断开钱包'), 'ok');
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
  // 开发模式下 Dock 图标可能还是 Launch Services 缓存的 Electron 图标，直接设置一次
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(SRC, '../build/icon.png'));

  tabSession = electronSession.fromPartition(PARTITION);
  tabSession.protocol.handle('tape', createTapeHandler(sites, { local: localSites, onServe: (origin, path, sha) => audit.file(origin, path, sha) }));
  // 电路网站发出的非链上请求（外部脚本、接口、WebSocket 等）记下来，网站信息面板和签名确认里提示
  tabSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
    try {
      const page = details.webContents && !details.webContents.isDestroyed() ? originOf(details.webContents.getURL()) : null;
      if (page && page.startsWith('tape://')) audit.external(page, details.url, details.resourceType);
    } catch { /* 记录失败不影响请求 */ }
    cb({});
  });
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  tabSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  tabSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  bridge = createBridgeServer({ token: settings.get('bridgeToken'), port: settings.get('bridgePort'), staticDir: join(SRC, 'bridge') });
  const port = await bridge.start();
  if (port !== settings.get('bridgePort')) settings.set('bridgePort', port);
  host = createProviderHost({ bridge, rpcs, settings, openBridge: () => shell.openExternal(bridge.url()), confirm, emit });
  bridge.on('state', (s) => { send('wallet', walletView()); bem.setAccount(s.ready ? s.accounts?.[0] : null); });

  // 临时钱包的私钥用系统钥匙串加密；不可用、或 Linux 上只有 basic_text 时服务拒绝发布（契约第 5 条）
  const secure = {
    available: () => safeStorage.isEncryptionAvailable(),
    // ready 之后才能读；只有 Linux 有这个方法，每次现读
    get backend() { return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() ?? null : null; },
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  };
  publish = createPublishService({
    chains, sites, localSites, precheck, bridge, secure,
    dir: join(app.getPath('userData'), 'publish'),
    onEvent: send,
    tr: (...a) => tr(...a),
  });

  registerIpc();
  // ready 之后系统语言才准
  lang = i18n.pick(settings.get('lang'), app.getLocale());
  tr = i18n.create(lang);
  buildMenu();
  if (app.isPackaged) app.setAsDefaultProtocolClient('tape');
  // Windows/Linux 双击链接时 URL 在 argv 里；mac 走 open-url（开发调试时也可以从命令行传）
  const argUrl = process.argv.find((a) => /^tape:\/\//i.test(a));
  if (argUrl) pendingExternal.push(argUrl);
  createWindow();
  // 上次没发完或没退干净的临时钱包：提示一次，发布页里再列出来（契约第 4 条）
  publish.leftovers().then(noticeLeftovers).catch((e) => console.error('publish leftovers:', e));
  // 启动稍等一会儿再自动检查更新，不和窗口加载抢；开发模式下不查
  if (app.isPackaged) setTimeout(() => { checkForUpdates(false).catch((e) => console.error('update check:', e)); }, 8000).unref?.();

  app.on('activate', () => { if (!win) createWindow(); });

  // 启动稍等一会再扫，避免和首屏网页抢 RPC
  // BEM 价格：没连钱包也显示
  bem.start();
  // 上次退出前目录里的变化（有更新、持有人变化）先标到最近访问和书签上
  library.syncDirectory(directory.list());
  setTimeout(() => refreshDirectory(), 5000).unref?.();
  setInterval(() => refreshDirectory(), QUICK_CHECK_EVERY).unref?.();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { library.flush(); contentStore.flush(); bridge?.stop(); });
