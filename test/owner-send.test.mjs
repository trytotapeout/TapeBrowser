import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerSend } from '../src/main/owner-send.js';
import * as E from '../src/main/publish-errors.js';
import { addChainParams } from '../src/main/provider-host.js';

const FROM = '0x' + 'ab'.repeat(20);
const TO = '0x' + 'cd'.repeat(20);
const HASH = '0x' + '12'.repeat(32);
const net = {
  name: 'Base', chainId: 8453, chainIdHex: '0x2105', currency: 'ETH',
  rpcs: ['https://mainnet.base.org'], explorer: 'https://basescan.org',
};
const ORIGIN = 'tape://publish';

/** 假 bridge：state 可改，request 记录调用；handlers[method] 决定返回或抛错 */
function fakeBridge(state = {}, handlers = {}) {
  const b = {
    state: { connected: true, ready: true, wallet: 'w', accounts: [FROM], chainId: net.chainIdHex, ...state },
    calls: [],
    async request(method, params, origin) {
      b.calls.push({ method, params, origin });
      const h = handlers[method];
      if (h) return h(params, b);
      if (method === 'eth_sendTransaction') return HASH;
      return null;
    },
  };
  return b;
}

const tx = () => ({ from: FROM, to: TO, value: 10n ** 18n, data: '0xdeadbeef' });
const make = (bridge, extra = {}) => createOwnerSend({ bridge, net, origin: ORIGIN, sleep: async () => {}, ...extra });

test('钱包没连接 → WALLET_NOT_CONNECTED，不发请求', async () => {
  const b = fakeBridge({ ready: false });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_NOT_CONNECTED && e.message === '请先连接钱包');
  assert.equal(b.calls.length, 0);
});

test('账户不是持有人 → WALLET_ACCOUNT', async () => {
  const b = fakeBridge({ accounts: ['0x' + '99'.repeat(20)] });
  await assert.rejects(make(b)(tx(), 'open'),
    (e) => e.code === E.WALLET_ACCOUNT && e.message === '钱包当前账户不是这个电路的持有人');
  assert.equal(b.calls.length, 0);
});

test('没有账户 → WALLET_ACCOUNT', async () => {
  const b = fakeBridge({ accounts: [] });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_ACCOUNT);
});

test('账户比较不分大小写', async () => {
  const b = fakeBridge();
  const t = { ...tx(), from: FROM.toUpperCase().replace('0X', '0x') };
  assert.equal(await make(b)(t, 'open'), HASH);
});

test('链不对 → 先切链，切好后照常发', async () => {
  const b = fakeBridge({ chainId: '0x1' }, {
    wallet_switchEthereumChain: (params, br) => { br.state = { ...br.state, chainId: net.chainIdHex }; return null; },
  });
  assert.equal(await make(b)(tx(), 'fund'), HASH);
  assert.deepEqual(b.calls[0], { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }], origin: ORIGIN });
  assert.equal(b.calls[1].method, 'eth_sendTransaction');
});

test('切链后状态晚一点才到：等几次再核对', async () => {
  let sleeps = 0;
  const b = fakeBridge({ chainId: '0x1' });
  const sleep = async () => { sleeps++; if (sleeps === 2) b.state = { ...b.state, chainId: net.chainIdHex }; };
  assert.equal(await make(b, { sleep })(tx(), 'fund'), HASH);
  assert.equal(sleeps, 2);
});

test('用户拒绝切链 → WALLET_CHAIN，带链名', async () => {
  const b = fakeBridge({ chainId: '0x1' }, {
    wallet_switchEthereumChain: () => { throw { code: 4001, message: 'rejected' }; },
  });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_CHAIN && e.message === '钱包没有切换到 Base');
  assert.equal(b.calls.length, 1);
});

test('切链后仍然不对 → WALLET_CHAIN，不发交易', async () => {
  let sleeps = 0;
  const b = fakeBridge({ chainId: '0x1' });
  await assert.rejects(make(b, { sleep: async () => { sleeps++; } })(tx(), 'open'),
    (e) => e.code === E.WALLET_CHAIN && e.message === '钱包没有切换到 Base');
  assert.ok(sleeps > 0);
  assert.ok(!b.calls.some((c) => c.method === 'eth_sendTransaction'));
});

test('切链时桥接断开 → WALLET_NOT_CONNECTED（还没发交易），不发交易', async () => {
  const b = fakeBridge({ chainId: '0x1' }, {
    wallet_switchEthereumChain: () => { throw { code: 4900, message: '钱包未连接' }; },
  });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_NOT_CONNECTED);
  assert.ok(!b.calls.some((c) => c.method === 'eth_sendTransaction'));
});

test('切链的其他错误包成 WALLET_ERROR', async () => {
  const err = { code: -32603, message: 'Internal error' };
  const b = fakeBridge({ chainId: '0x1' }, { wallet_switchEthereumChain: () => { throw err; } });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_ERROR && e.cause === err);
  assert.ok(!b.calls.some((c) => c.method === 'eth_sendTransaction'));
  assert.ok(!b.calls.some((c) => c.method === 'eth_sendTransaction'));
});

test('发之前调 onStep({ kind, value })', async () => {
  const order = [];
  const b = fakeBridge({}, { eth_sendTransaction: () => { order.push('send'); return HASH; } });
  const onStep = (s) => order.push(s);
  await make(b, { onStep })(tx(), 'grant');
  assert.deepEqual(order, [{ kind: 'grant', value: 10n ** 18n }, 'send']);
});

test('没有 onStep 也能发', async () => {
  assert.equal(await createOwnerSend({ bridge: fakeBridge(), net, origin: ORIGIN })(tx(), 'open'), HASH);
});

test('bigint 和数字转 0x 十六进制，字符串原样，带上 chainId，不加 gas / nonce', async () => {
  const b = fakeBridge();
  await make(b)({ ...tx(), value: 255n, extra: 16 }, 'open');
  const send = b.calls.find((c) => c.method === 'eth_sendTransaction');
  assert.deepEqual(send.params, [{ from: FROM, to: TO, value: '0xff', data: '0xdeadbeef', extra: '0x10', chainId: '0x2105' }]);
  assert.equal(send.origin, ORIGIN);
});

test('0n 转成 0x0', async () => {
  const b = fakeBridge();
  await make(b)({ ...tx(), value: 0n }, 'grant');
  assert.equal(b.calls.at(-1).params[0].value, '0x0');
});

test('传入的 tx 不被修改', async () => {
  const t = tx();
  await make(fakeBridge())(t, 'open');
  assert.equal(t.value, 10n ** 18n);
});

test('返回值原样交回（格式由 publisher 检查）', async () => {
  const b = fakeBridge({}, { eth_sendTransaction: () => 'not-a-hash' });
  assert.equal(await make(b)(tx(), 'open'), 'not-a-hash');
});

test('用户拒绝 → USER_REJECTED', async () => {
  const b = fakeBridge({}, { eth_sendTransaction: () => { throw { code: 4001, message: 'User rejected' }; } });
  await assert.rejects(make(b)(tx(), 'open'),
    (e) => e.code === E.USER_REJECTED && e.message === '你在钱包里拒绝了这笔交易');
});

const LOST = '钱包没有回应，交易可能已经发出；稍后继续时会先检查';

test('超时（4001 + timeout）→ WALLET_LOST', async () => {
  const b = fakeBridge({}, { eth_sendTransaction: () => { throw { code: 4001, message: 'timeout', timeout: true }; } });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_LOST && e.message === LOST);
});

test('4900 → WALLET_LOST', async () => {
  const b = fakeBridge({}, { eth_sendTransaction: () => { throw { code: 4900, message: '钱包未连接' }; } });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_LOST && e.message === LOST);
});

test('钱包的其他错误（-32603）包成 WALLET_ERROR，带 cause 和 walletCode', async () => {
  const err = { code: -32603, message: 'Internal JSON-RPC error' };
  const b = fakeBridge({}, { eth_sendTransaction: () => { throw err; } });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e instanceof Error && e.code === E.WALLET_ERROR
    && e.message === 'Internal JSON-RPC error' && e.cause === err && e.walletCode === -32603);
});

test('4100（账户没授权）→ WALLET_ACCOUNT', async () => {
  const b = fakeBridge({}, { eth_sendTransaction: () => { throw { code: 4100, message: 'Unauthorized' }; } });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_ACCOUNT);
});

test('已经带字符串 code 的 Error 原样抛出', async () => {
  const err = Object.assign(new Error('boom'), { code: 'SOMETHING' });
  const b = fakeBridge({}, { eth_sendTransaction: () => { throw err; } });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e === err);
});

test('交易参数里带 chainId：确认框开着时切了链，钱包会拒签', async () => {
  const b = fakeBridge();
  await make(b)(tx(), 'fund');
  assert.equal(b.calls.at(-1).params[0].chainId, net.chainIdHex);
});

test('4902（钱包里没有这条链）→ 添加链 → 照常发', async () => {
  const b = fakeBridge({ chainId: '0x1' }, {
    wallet_switchEthereumChain: () => { throw { code: 4902, message: 'Unrecognized chain' }; },
    wallet_addEthereumChain: (params, br) => { br.state = { ...br.state, chainId: net.chainIdHex }; return null; },
  });
  assert.equal(await make(b)(tx(), 'open'), HASH);
  assert.deepEqual(b.calls[1], { method: 'wallet_addEthereumChain', params: [addChainParams(net)], origin: ORIGIN });
  assert.equal(b.calls[2].method, 'eth_sendTransaction');
});

test('4902 → 用户拒绝添加链 → WALLET_CHAIN', async () => {
  const b = fakeBridge({ chainId: '0x1' }, {
    wallet_switchEthereumChain: () => { throw { code: 4902, message: 'Unrecognized chain' }; },
    wallet_addEthereumChain: () => { throw { code: 4001, message: 'rejected' }; },
  });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_CHAIN && e.message === '钱包没有切换到 Base');
  assert.ok(!b.calls.some((c) => c.method === 'eth_sendTransaction'));
});

test('切链超时（4001 + timeout）→ WALLET_CHAIN', async () => {
  const b = fakeBridge({ chainId: '0x1' }, {
    wallet_switchEthereumChain: () => { throw { code: 4001, message: 'timeout', timeout: true }; },
  });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_CHAIN);
});

test('切链后桥接断开（ready 变假）→ WALLET_NOT_CONNECTED，不发交易', async () => {
  const b = fakeBridge({ chainId: '0x1' }, {
    wallet_switchEthereumChain: (params, br) => {
      br.state = { ...br.state, chainId: net.chainIdHex, ready: false };
      return null;
    },
  });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_NOT_CONNECTED);
  assert.ok(!b.calls.some((c) => c.method === 'eth_sendTransaction'));
});

test('onStep 期间断开 → 发之前再查 ready，WALLET_NOT_CONNECTED', async () => {
  const b = fakeBridge();
  const onStep = () => { b.state = { ...b.state, ready: false }; };
  await assert.rejects(make(b, { onStep })(tx(), 'open'), (e) => e.code === E.WALLET_NOT_CONNECTED);
  assert.ok(!b.calls.some((c) => c.method === 'eth_sendTransaction'));
});

test('切链期间换了账户 → WALLET_ACCOUNT，不发交易', async () => {
  const b = fakeBridge({ chainId: '0x1' }, {
    wallet_switchEthereumChain: (params, br) => {
      br.state = { ...br.state, chainId: net.chainIdHex, accounts: ['0x' + '99'.repeat(20)] };
      return null;
    },
  });
  await assert.rejects(make(b)(tx(), 'open'), (e) => e.code === E.WALLET_ACCOUNT);
  assert.ok(!b.calls.some((c) => c.method === 'eth_sendTransaction'));
});
