import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProviderHost } from '../src/main/provider-host.js';
import { describeRequest } from '../src/main/describe.js';

const ACC = '0x571d447f4f24688ec35ccf07f1d6993655f6af15';
const SITE = 'tape://4454-0';

function setup({ confirmOk = true, remember = false, switchError = null, walletChain = '0x38' } = {}) {
  const ev = new EventEmitter();
  const calls = [];
  let state = { connected: false, ready: false, wallet: null, accounts: [], chainId: null };
  const bridge = {
    get state() { return state; },
    on: (n, fn) => ev.on(n, fn),
    async waitReady() { return state; },
    async request(method, params, origin) {
      calls.push({ method, params, origin });
      if (method === 'eth_requestAccounts') return [ACC];
      if (method === 'wallet_switchEthereumChain') {
        if (switchError) throw switchError;
        state = { ...state, chainId: params[0].chainId };
        return null;
      }
      if (method === 'wallet_addEthereumChain') { state = { ...state, chainId: params[0].chainId }; return null; }
      return 'wallet:' + method;
    },
  };
  const set = (next) => { const prev = state; state = { ...state, ...next }; ev.emit('state', state, prev); };
  const perms = new Map();
  const settings = { isPermitted: (o) => perms.has(o), permit: (o) => perms.set(o, 1), revoke: (o) => perms.delete(o), permittedOrigins: () => [...perms.keys()] };
  const rpcCalls = [];
  const pool = (key) => async (m) => { rpcCalls.push(key + ':' + m); return `rpc:${key}:${m}`; };
  const rpcs = { bnb: pool('bnb'), xlayer: pool('xlayer'), base: pool('base') };
  const confirms = [];
  const emits = [];
  let opened = 0;
  const host = createProviderHost({
    bridge, rpcs, settings,
    openBridge: () => { opened++; set({ connected: true, ready: true, wallet: 'MetaMask', accounts: [], chainId: walletChain }); },
    confirm: async (r) => { confirms.push(r); return { ok: confirmOk, remember }; },
    emit: (o, e, p) => emits.push([o, e, p]),
  });
  return { host, set, calls, rpcCalls, confirms, emits, perms, opened: () => opened };
}

test('未连接时：chainId 默认 BSC，eth_accounts 为空，只读走内置节点', async () => {
  const t = setup();
  assert.equal(await t.host.handle(SITE, 'eth_chainId'), '0x38');
  assert.deepEqual(await t.host.handle(SITE, 'eth_accounts'), []);
  assert.equal(await t.host.handle(SITE, 'eth_call', [{}, 'latest']), 'rpc:bnb:eth_call');
});

test('eth_requestAccounts：打开桥接页、钱包授权、TapeBrowser 确认后返回地址', async () => {
  const t = setup();
  assert.deepEqual(await t.host.handle(SITE, 'eth_requestAccounts'), [ACC]);
  assert.equal(t.opened(), 1);
  assert.equal(t.confirms[0].kind, 'connect');
  assert.equal(t.confirms[0].origin, SITE);
  assert.ok(t.perms.has(SITE));
  // 第二次不再弹窗
  await t.host.handle(SITE, 'eth_requestAccounts');
  assert.equal(t.confirms.length, 1);
});

test('用户拒绝连接返回 4001，且不授权', async () => {
  const t = setup({ confirmOk: false });
  await assert.rejects(t.host.handle(SITE, 'eth_requestAccounts'), (e) => e.code === 4001);
  assert.ok(!t.perms.has(SITE));
});

test('未授权网站不能签名', async () => {
  const t = setup();
  t.set({ connected: true, ready: true, accounts: [ACC], chainId: '0x38' });
  await assert.rejects(t.host.handle('tape://1-0', 'personal_sign', ['0x68', ACC]), (e) => e.code === 4100);
  assert.equal(t.calls.length, 0);
});

test('已授权网站签名：先弹窗再交给钱包；签名地址必须是当前钱包', async () => {
  const t = setup();
  t.set({ connected: true, ready: true, accounts: [ACC], chainId: '0x38' });
  t.perms.set(SITE, 1);
  assert.equal(await t.host.handle(SITE, 'personal_sign', ['0x68656c6c6f', ACC]), 'wallet:personal_sign');
  assert.equal(t.confirms.length, 1);
  assert.equal(t.calls[0].origin, SITE);
  await assert.rejects(t.host.handle(SITE, 'personal_sign', ['0x68', '0x' + '1'.repeat(40)]), (e) => e.code === 4100);
});

test('勾选"不再询问"后同一网站不再弹窗', async () => {
  const t = setup({ remember: true });
  t.set({ connected: true, ready: true, accounts: [ACC], chainId: '0x38' });
  t.perms.set(SITE, 1);
  await t.host.handle(SITE, 'eth_sendTransaction', [{ from: ACC, to: ACC }]);
  await t.host.handle(SITE, 'eth_sendTransaction', [{ from: ACC, to: ACC }]);
  assert.equal(t.confirms.length, 1);
  assert.equal(t.calls.length, 2);
});

test('钱包切到别的链时只读请求转给钱包，并派发 chainChanged', async () => {
  const t = setup();
  t.set({ connected: true, ready: true, accounts: [ACC], chainId: '0x1' });
  assert.equal(await t.host.handle(SITE, 'eth_chainId'), '0x1');
  assert.equal(await t.host.handle(SITE, 'eth_blockNumber'), 'wallet:eth_blockNumber');
  // chainChanged 的值按每个网页自己的来源算
  const ev = t.emits.find((e) => e[1] === 'chainChanged');
  assert.equal(ev[0], null);
  assert.equal(ev[2](SITE), '0x1');
});

test('账户变化只通知已授权网站；断开时发空数组', async () => {
  const t = setup();
  t.perms.set(SITE, 1);
  const acc = () => t.emits.filter((e) => e[1] === 'accountsChanged').at(-1);
  t.set({ connected: true, ready: true, accounts: [ACC], chainId: '0x38' });
  assert.deepEqual(acc(), [SITE, 'accountsChanged', [ACC]]);
  t.set({ connected: false, ready: false, accounts: [], chainId: null });
  assert.deepEqual(acc(), [SITE, 'accountsChanged', []]);
});

test('describeRequest 解码 personal_sign 文本和交易金额', () => {
  assert.equal(describeRequest('personal_sign', ['0x' + Buffer.from('你好').toString('hex'), ACC]).body, '你好');
  assert.match(describeRequest('eth_sendTransaction', [{ to: ACC, value: '0xde0b6b3a7640000', data: '0x1234' }]).body, /1 BNB[\s\S]*2 字节/);
});

const XSITE = 'tape://1-2-230';

test('X Layer、Base 网站：没连钱包时 chainId 是网站所在的链，只读走那条链的节点', async () => {
  const t = setup();
  assert.equal(await t.host.handle(XSITE, 'eth_chainId'), '0xc4');
  assert.equal(await t.host.handle(XSITE, 'net_version'), '196');
  assert.equal(await t.host.handle(XSITE, 'eth_blockNumber'), 'rpc:xlayer:eth_blockNumber');
  assert.equal(await t.host.handle('tape://1-3-5', 'eth_chainId'), '0x2105');
  assert.equal(await t.host.handle('tape://1-3-5', 'eth_call', [{}]), 'rpc:base:eth_call');
  // 普通网站默认 BNB
  assert.equal(await t.host.handle('https://example.com', 'eth_chainId'), '0x38');
  assert.deepEqual(t.host.initial(XSITE).chainId, '0xc4');
});

test('钱包连着时以钱包当前的链为准；钱包在 X Layer 上时只读走 X Layer 节点', async () => {
  const t = setup();
  t.set({ connected: true, ready: true, accounts: [ACC], chainId: '0xc4' });
  assert.equal(await t.host.handle(SITE, 'eth_chainId'), '0xc4');
  assert.equal(await t.host.handle(SITE, 'eth_blockNumber'), 'rpc:xlayer:eth_blockNumber');
  assert.equal(t.calls.length, 0, '不打扰钱包');
});

test('X Layer 网站第一次连接：钱包在 BNB 上就请钱包切到 X Layer', async () => {
  const t = setup();
  assert.deepEqual(await t.host.handle(XSITE, 'eth_requestAccounts'), [ACC]);
  const sw = t.calls.find((c) => c.method === 'wallet_switchEthereumChain');
  assert.deepEqual(sw.params, [{ chainId: '0xc4' }]);
  assert.equal(sw.origin, XSITE);
  assert.equal(await t.host.handle(XSITE, 'eth_chainId'), '0xc4');
});

test('钱包里没有这条链（4902）就先添加；用户拒绝切换不影响连接', async () => {
  const t = setup({ switchError: { code: 4902, message: 'Unrecognized chain' } });
  await t.host.handle('tape://1-3-5', 'eth_requestAccounts');
  const add = t.calls.find((c) => c.method === 'wallet_addEthereumChain');
  assert.equal(add.params[0].chainId, '0x2105');
  assert.equal(add.params[0].nativeCurrency.symbol, 'ETH');
  assert.ok(add.params[0].rpcUrls[0].startsWith('https://'));

  const t2 = setup({ switchError: { code: 4001, message: 'User rejected' } });
  assert.deepEqual(await t2.host.handle(XSITE, 'eth_requestAccounts'), [ACC]);
  assert.ok(!t2.calls.some((c) => c.method === 'wallet_addEthereumChain'));
});

test('钱包已经在网站所在的链上、或是普通网站：连接时不切链', async () => {
  const t = setup({ walletChain: '0xc4' });
  await t.host.handle(XSITE, 'eth_requestAccounts');
  const t2 = setup();
  await t2.host.handle('https://example.com', 'eth_requestAccounts');
  assert.ok(![...t.calls, ...t2.calls].some((c) => c.method === 'wallet_switchEthereumChain'));
});
