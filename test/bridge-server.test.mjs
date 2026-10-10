import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createBridgeServer } from '../src/main/bridge-server.js';

const staticDir = fileURLToPath(new URL('../src/bridge/', import.meta.url));
const TOKEN = 'a'.repeat(48);
const ACC = '0x571d447f4f24688ec35ccf07f1d6993655f6af15';

async function withServer(fn, opts = {}) {
  const b = createBridgeServer({ token: TOKEN, port: 0, staticDir, ...opts });
  const port = await b.start();
  try { await fn(b, port); } finally { await b.stop(); }
}

function connect(port, { token = TOKEN, origin = `http://127.0.0.1:${port}` } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`, { origin });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
    ws.once('error', reject);
  });
}

const nextMessage = (ws) => new Promise((r) => ws.once('message', (m) => r(JSON.parse(String(m)))));
const nextState = (b) => new Promise((r) => b.on('state', (s) => r(s)));

test('页面需要口令，Host 不对一律拒绝', async () => {
  await withServer(async (b, port) => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 403);
    const ok = await fetch(b.url());
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/bridge.js`)).status, 200);
    assert.equal((await fetch(`http://localhost:${port}/bridge.js`)).status, 403);
  });
});

test('WebSocket 口令或 Origin 不对被拒绝', async () => {
  await withServer(async (_b, port) => {
    await assert.rejects(connect(port, { token: 'b'.repeat(48) }), /403/);
    await assert.rejects(connect(port, { origin: 'https://evil.example' }), /403/);
  });
});

test('state 同步、请求转发与错误', async () => {
  await withServer(async (b, port) => {
    const ws = await connect(port);
    const st = nextState(b);
    ws.send(JSON.stringify({ type: 'state', ready: true, wallet: 'MetaMask', accounts: [ACC.toUpperCase().replace('0X', '0x')], chainId: '0x38' }));
    const s = await st;
    assert.equal(s.ready, true);
    assert.deepEqual(s.accounts, [ACC]);

    const msg = nextMessage(ws);
    const p = b.request('personal_sign', ['0x68', ACC], 'tape://4454-0');
    const req = await msg;
    assert.equal(req.origin, 'tape://4454-0');
    ws.send(JSON.stringify({ type: 'response', id: req.id, result: '0xsig' }));
    assert.equal(await p, '0xsig');

    const msg2 = nextMessage(ws);
    const p2 = b.request('eth_sendTransaction', [{}], 'x');
    const req2 = await msg2;
    ws.send(JSON.stringify({ type: 'response', id: req2.id, error: { code: 4001, message: 'User rejected' } }));
    await assert.rejects(p2, (e) => e.code === 4001);
    ws.close();
  });
});

test('新页面接入替换旧页面（关闭码 4000），旧页面未完成请求失败', async () => {
  await withServer(async (b, port) => {
    const ws1 = await connect(port);
    const st = nextState(b);
    ws1.send(JSON.stringify({ type: 'state', ready: true, accounts: [ACC], chainId: '0x38' }));
    await st;
    const pending = b.request('eth_accounts', [], 'x').then(() => null, (e) => e);
    const closed = new Promise((r) => ws1.once('close', (code) => r(code)));
    const ws2 = await connect(port);
    assert.equal(await closed, 4000);
    assert.equal((await pending)?.code, 4900);
    assert.equal(b.state.connected, true);
    assert.equal(b.state.ready, false);
    ws2.close();
  });
});

test('从 TapeBrowser 断开：本地立即清空地址并通知页面，页面连接保留', async () => {
  await withServer(async (b, port) => {
    const ws = await connect(port);
    const st = nextState(b);
    ws.send(JSON.stringify({ type: 'state', ready: true, wallet: 'OKX Wallet', accounts: [ACC], chainId: '0x38' }));
    await st;
    const msg = nextMessage(ws);
    b.disconnect();
    assert.deepEqual(await msg, { type: 'disconnect' });
    assert.equal(b.state.ready, false);
    assert.deepEqual(b.state.accounts, []);
    assert.equal(b.state.connected, true);
    ws.close();
  });
});

test('页面关闭后状态复位', async () => {
  await withServer(async (b, port) => {
    const ws = await connect(port);
    const st = nextState(b);
    ws.close();
    // 先收到 attach 时的 state 再收到 close 的
    await st;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(b.state.connected, false);
  });
});

async function readyPage(b, port) {
  const ws = await connect(port);
  const st = nextState(b);
  ws.send(JSON.stringify({ type: 'state', ready: true, accounts: [ACC], chainId: '0x38' }));
  await st;
  return ws;
}

test('请求超时：code 4001 并带 timeout 标记', async () => {
  await withServer(async (b, port) => {
    const ws = await readyPage(b, port);
    const e = await b.request('eth_sendTransaction', [{}], 'x').then(() => null, (err) => err);
    assert.deepEqual(e, { code: 4001, message: '钱包请求超时', timeout: true });
    ws.close();
  }, { requestTimeout: 30 });
});

test('钱包返回的 4001 不带 timeout 标记', async () => {
  await withServer(async (b, port) => {
    const ws = await readyPage(b, port);
    const msg = nextMessage(ws);
    const p = b.request('eth_sendTransaction', [{}], 'x').then(() => null, (err) => err);
    const req = await msg;
    ws.send(JSON.stringify({ type: 'response', id: req.id, error: { code: 4001, message: 'User rejected' } }));
    const e = await p;
    assert.equal(e.code, 4001);
    assert.equal('timeout' in e, false);
    ws.close();
  });
});

test('页面关闭时未完成请求以 4900 失败', async () => {
  await withServer(async (b, port) => {
    const ws = await readyPage(b, port);
    const msg = nextMessage(ws);
    const p = b.request('eth_accounts', [], 'x').then(() => null, (err) => err);
    await msg;
    ws.close();
    const e = await p;
    assert.equal(e.code, 4900);
    assert.equal('timeout' in e, false);
  });
});
