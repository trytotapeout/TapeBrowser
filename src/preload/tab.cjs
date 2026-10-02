// 网页标签的 preload（sandbox 下运行，必须是 CommonJS）。
// 在网页主世界里注入 window.ethereum（EIP-1193），并按 EIP-6963 公告。
// 所有请求经 IPC 交给主进程的 provider-host 处理，网页拿不到任何 Node / Electron 能力。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('eth:event', (_e, event, payload) => {
  for (const fn of listeners) { try { fn(event, payload); } catch { /* 网页回调出错不影响其他回调 */ } }
});

const api = {
  // 返回 {ok, result} 或 {ok:false, error:{code, message, data}}：Error 对象跨 contextBridge 会丢掉 code
  request: (method, params) => ipcRenderer.invoke('eth:request', method, params),
  initial: () => ipcRenderer.invoke('eth:initial'),
  subscribe: (fn) => { listeners.add(fn); },
};

/** 在主世界里执行：只能用参数，不能引用 preload 里的变量 */
function installProvider(api, icon) {
  if (window.ethereum && window.ethereum.isTapeBrowser) return;
  const handlers = new Map();
  const state = { chainId: null, accounts: [], connected: false };

  function emit(event, ...args) {
    const set = handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) { try { fn(...args); } catch (e) { setTimeout(() => { throw e; }); } }
  }

  function toError(e) {
    const err = new Error(e && e.message ? e.message : '请求失败');
    err.code = e && typeof e.code === 'number' ? e.code : -32603;
    if (e && e.data !== undefined) err.data = e.data;
    return err;
  }

  async function request(args) {
    if (!args || typeof args !== 'object' || typeof args.method !== 'string') throw toError({ code: -32600, message: 'request 需要 { method, params }' });
    const r = await api.request(args.method, args.params === undefined ? [] : args.params);
    if (!r || !r.ok) throw toError(r && r.error);
    if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') {
      const next = r.result || [];
      if (next.join() !== state.accounts.join()) { state.accounts = next; emit('accountsChanged', next); }
    }
    return r.result;
  }

  const provider = {
    isTapeBrowser: true,
    isMetaMask: false,
    request,
    on(event, fn) { if (typeof fn === 'function') { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); } return provider; },
    addListener(event, fn) { return provider.on(event, fn); },
    once(event, fn) { const w = (...a) => { provider.removeListener(event, w); fn(...a); }; return provider.on(event, w); },
    removeListener(event, fn) { handlers.get(event)?.delete(fn); return provider; },
    off(event, fn) { return provider.removeListener(event, fn); },
    removeAllListeners(event) { if (event) handlers.delete(event); else handlers.clear(); return provider; },
    isConnected: () => state.connected,
    enable: () => request({ method: 'eth_requestAccounts' }),
    // 旧接口：send(method, params) / send(payload, callback) / sendAsync(payload, callback)
    send(a, b) {
      if (typeof a === 'string') return request({ method: a, params: b });
      if (typeof b === 'function') return provider.sendAsync(a, b);
      throw toError({ code: 4200, message: '不支持同步 send' });
    },
    sendAsync(payload, cb) {
      request(payload).then(
        (result) => cb(null, { id: payload.id, jsonrpc: '2.0', result }),
        (error) => cb(error, { id: payload.id, jsonrpc: '2.0', error: { code: error.code, message: error.message } }),
      );
    },
  };
  Object.defineProperty(provider, 'chainId', { get: () => state.chainId, enumerable: true });
  Object.defineProperty(provider, 'selectedAddress', { get: () => state.accounts[0] || null, enumerable: true });
  Object.defineProperty(provider, 'networkVersion', { get: () => (state.chainId ? String(parseInt(state.chainId, 16)) : null), enumerable: true });

  api.subscribe((event, payload) => {
    if (event === 'accountsChanged') {
      const next = Array.isArray(payload) ? payload : [];
      if (next.join() === state.accounts.join()) return;
      state.accounts = next;
    } else if (event === 'chainChanged') {
      if (payload === state.chainId) return;
      state.chainId = payload;
    }
    emit(event, payload);
  });

  api.initial().then((s) => {
    state.chainId = s.chainId;
    state.accounts = s.accounts || [];
    state.connected = true;
    emit('connect', { chainId: s.chainId });
  });

  Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: true });

  const detail = Object.freeze({
    info: Object.freeze({
      uuid: crypto.randomUUID(),
      name: 'TapeBrowser',
      icon,
      rdns: 'org.tapekit.tapebrowser',
    }),
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  window.dispatchEvent(new Event('ethereum#initialized'));
}

const ICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f6feb"/>'
  + '<rect x="6" y="10" width="20" height="12" rx="3" fill="none" stroke="#fff" stroke-width="2"/>'
  + '<circle cx="12" cy="16" r="2.5" fill="#fff"/><circle cx="20" cy="16" r="2.5" fill="#fff"/></svg>');

contextBridge.executeInMainWorld({ func: installProvider, args: [api, ICON] });
