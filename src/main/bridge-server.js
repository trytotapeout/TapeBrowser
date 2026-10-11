// 钱包桥接服务：在 127.0.0.1 上起一个 HTTP + WebSocket 服务，
// 用户在系统浏览器里打开桥接页面，页面里的钱包扩展（MetaMask 等）通过 WebSocket 替 TapeBrowser 签名。
//
// 安全：
//   - 只监听 127.0.0.1；校验 Host（防 DNS rebinding）和 Origin
//   - 页面与 WebSocket 都要带口令 ?t=<bridgeToken>，其他本地网页拿不到口令就接不进来
//   - 同一时间只认最新接入的一个页面
// 不依赖 Electron。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const STATIC = { '/bridge.js': 'text/javascript; charset=utf-8', '/bridge.css': 'text/css; charset=utf-8' };
const REQUEST_TIMEOUT = 5 * 60 * 1000;

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createBridgeServer({ token, port = 0, staticDir, requestTimeout = REQUEST_TIMEOUT }) {
  const ev = new EventEmitter();
  let server;
  let wss;
  let socket = null;
  let actualPort = 0;
  let seq = 0;
  const pending = new Map();
  let state = { connected: false, ready: false, wallet: null, accounts: [], chainId: null };

  const expectedHost = () => `127.0.0.1:${actualPort}`;
  const expectedOrigin = () => `http://${expectedHost()}`;

  function setState(next) {
    const prev = state;
    state = { ...state, ...next };
    ev.emit('state', state, prev);
  }

  function failPending(code, message) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject({ code, message }); }
    pending.clear();
  }

  function csp() {
    return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ws://${expectedHost()}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
  }

  async function onHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.headers.host !== expectedHost() || req.method !== 'GET') { res.writeHead(403).end(); return; }
    const headers = { 'content-security-policy': csp(), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    try {
      if (url.pathname === '/') {
        if (!sameToken(url.searchParams.get('t'), token)) { res.writeHead(403, headers).end('forbidden'); return; }
        const body = await readFile(join(staticDir, 'bridge.html'));
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(body);
        return;
      }
      if (STATIC[url.pathname]) {
        const body = await readFile(join(staticDir, url.pathname.slice(1)));
        res.writeHead(200, { ...headers, 'content-type': STATIC[url.pathname] }).end(body);
        return;
      }
      res.writeHead(404, headers).end();
    } catch {
      res.writeHead(500, headers).end();
    }
  }

  function onUpgrade(req, sock, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' || req.headers.host !== expectedHost() || req.headers.origin !== expectedOrigin()
      || !sameToken(url.searchParams.get('t'), token)) {
      sock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => attach(ws));
  }

  function attach(ws) {
    if (socket) {
      const old = socket;
      socket = null;
      old.close(4000, 'replaced');
    }
    socket = ws;
    failPending(4900, '钱包桥接页面已更换');
    setState({ connected: true, ready: false, wallet: null, accounts: [], chainId: null });

    ws.on('message', (raw) => {
      if (ws !== socket) return;
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'state') {
        setState({
          ready: Boolean(msg.ready),
          wallet: typeof msg.wallet === 'string' ? msg.wallet.slice(0, 64) : null,
          accounts: Array.isArray(msg.accounts) ? msg.accounts.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase()) : [],
          chainId: typeof msg.chainId === 'string' && /^0x[0-9a-fA-F]+$/.test(msg.chainId) ? msg.chainId.toLowerCase() : null,
        });
      } else if (msg.type === 'response') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject({ code: Number(msg.error.code) || -32603, message: String(msg.error.message || '钱包返回错误'), data: msg.error.data });
        else p.resolve(msg.result);
      }
    });
    ws.on('close', () => {
      if (ws !== socket) return;
      socket = null;
      failPending(4900, '钱包桥接页面已关闭');
      setState({ connected: false, ready: false, wallet: null, accounts: [], chainId: null });
    });
    ws.on('error', () => {});
  }

  /** 把请求交给桥接页面里的钱包；返回 result，失败 reject {code, message, data} */
  function request(method, params, origin) {
    if (!socket || !state.ready) return Promise.reject({ code: 4900, message: '钱包未连接' });
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject({ code: 4001, message: '钱包请求超时', timeout: true }); }, requestTimeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'request', id, method, params, origin }));
    });
  }

  /** 从 TapeBrowser 断开钱包：本地立即清空地址，并通知桥接页面放弃当前钱包（页面保持连接，可以重新选择） */
  function disconnect() {
    failPending(4900, '钱包已断开');
    if (socket) socket.send(JSON.stringify({ type: 'disconnect' }));
    setState({ ready: false, wallet: null, accounts: [], chainId: null });
  }

  /** 钱包确认切链成功后直接记下新链（不等桥接页面上报：旧版桥接页面或不发 chainChanged 的钱包会一直报旧链） */
  function noteChain(chainId) {
    if (state.ready && /^0x[0-9a-f]+$/.test(chainId) && state.chainId !== chainId) setState({ chainId });
  }

  /** 等待桥接页面选好钱包；超时 reject */
  function waitReady(timeoutMs) {
    if (state.ready) return Promise.resolve(state);
    return new Promise((resolve, reject) => {
      const onState = (s) => { if (s.ready) { cleanup(); resolve(s); } };
      const timer = setTimeout(() => { cleanup(); reject({ code: 4001, message: '没有在浏览器里连接钱包' }); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); ev.off('state', onState); };
      ev.on('state', onState);
    });
  }

  function listen(p) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
    });
  }

  async function start() {
    server = http.createServer((req, res) => { onHttp(req, res); });
    wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    server.on('upgrade', onUpgrade);
    try {
      actualPort = await listen(port);
    } catch (e) {
      if (!port || e.code !== 'EADDRINUSE') throw e;
      actualPort = await listen(0);
    }
    return actualPort;
  }

  async function stop() {
    failPending(4900, '已退出');
    socket?.close();
    wss?.close();
    await new Promise((r) => (server ? server.close(() => r()) : r()));
  }

  return {
    start,
    stop,
    request,
    disconnect,
    noteChain,
    waitReady,
    on: (name, fn) => ev.on(name, fn),
    get state() { return state; },
    get port() { return actualPort; },
    url: () => `${expectedOrigin()}/?t=${token}`,
  };
}
