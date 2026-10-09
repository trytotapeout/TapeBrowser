// chain.js 里给发布流程用的只读调用：用假 rpc 按 to + 选择器返回编码好的结果
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChain } from '../src/main/chain.js';
import { RpcError } from '../src/main/rpc.js';
import { SEL } from '../src/main/config.js';

const NET = {
  key: 'test',
  chainId: 56,
  opener: '0x' + '11'.repeat(20),
  registry: '0x' + '22'.repeat(20),
  multicall3: '0x' + '33'.repeat(20),
};
const CIRCUITS = '0x' + '44'.repeat(20);
const CONTAINER = '0x' + '55'.repeat(20);
const OPERATOR = '0x' + '66'.repeat(20);

const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const ret = (...words) => '0x' + words.map(word).join('');

/** 手工解析 aggregate3 的 calldata → [{target, callData}] */
function parseAggregate3(data) {
  const h = data.slice(10);
  const at = (byte) => BigInt('0x' + h.slice(byte * 2, byte * 2 + 64));
  const p = Number(at(0));
  const n = Number(at(p));
  const start = p + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = start + Number(at(start + i * 32));
    const target = '0x' + h.slice((t + 12) * 2, (t + 32) * 2);
    const d = t + Number(at(t + 64));
    const len = Number(at(d));
    out.push({ target, callData: '0x' + h.slice((d + 32) * 2, (d + 32 + len) * 2) });
  }
  return out;
}

/** 编码 aggregate3 的返回值 (bool, bytes)[] */
function encodeAggregate3(results) {
  const items = results.map(({ success, returnData }) => {
    const b = returnData.slice(2);
    return word(success ? 1 : 0) + word(64) + word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0');
  });
  let head = '';
  let tail = '';
  for (const it of items) { head += word(items.length * 32 + tail.length / 2); tail += it; }
  return '0x' + word(32) + word(items.length) + head + tail;
}

/** 假节点：handlers[method](params)；eth_call 按 `${to}:${selector}` 查 calls，multicall 拆开逐个应答 */
function fakeRpc({ calls = {}, handlers = {} } = {}) {
  const log = [];
  function ethCall(to, data) {
    const fn = calls[`${to.toLowerCase()}:${data.slice(0, 10)}`];
    if (!fn) throw new RpcError('execution reverted', 3, '0x');
    return fn(data);
  }
  async function rpc(method, params) {
    log.push({ method, params });
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (to === NET.multicall3 && data.startsWith(SEL.aggregate3)) {
        return encodeAggregate3(parseAggregate3(data).map((c) => {
          try { return { success: true, returnData: ethCall(c.target, c.callData) }; } catch { return { success: false, returnData: '0x' }; }
        }));
      }
      return ethCall(to, data);
    }
    const h = handlers[method];
    if (!h) throw new RpcError('method not found', -32601);
    return h(params);
  }
  rpc.log = log;
  return rpc;
}

test('openFee 读 opener.FEE() 返回 bigint', async () => {
  const rpc = fakeRpc({ calls: { [`${NET.opener}:${SEL.openFee}`]: () => ret(10n ** 16n) } });
  const fee = await createChain(rpc, NET).openFee();
  assert.equal(fee, 10n ** 16n);
});

test('isDeployed 读 opener.isDeployed 返回 bool', async () => {
  let seen;
  const rpc = fakeRpc({ calls: { [`${NET.opener}:${SEL.isDeployed}`]: (d) => { seen = d; return ret(1); } } });
  assert.equal(await createChain(rpc, NET).isDeployed(CIRCUITS, 7), true);
  assert.equal(seen, SEL.isDeployed + word(CIRCUITS) + word(7));
  const rpc2 = fakeRpc({ calls: { [`${NET.opener}:${SEL.isDeployed}`]: () => ret(0) } });
  assert.equal(await createChain(rpc2, NET).isDeployed(CIRCUITS, 7), false);
});

test('operatorState 用一次 multicall 读 canEdit 和 operatorUntil', async () => {
  let edit;
  const rpc = fakeRpc({
    calls: {
      [`${NET.registry}:${SEL.canEdit}`]: (d) => { edit = d; return ret(1); },
      [`${NET.registry}:${SEL.operatorUntil}`]: () => ret(1760000000),
    },
  });
  const st = await createChain(rpc, NET).operatorState(CONTAINER, OPERATOR);
  assert.deepEqual(st, { canEdit: true, until: 1760000000 });
  assert.equal(edit, SEL.canEdit + word(CONTAINER) + word(OPERATOR));
  assert.equal(rpc.log.length, 1);
  assert.equal(rpc.log[0].params[0].to, NET.multicall3);
});

test('operatorState 没有操作员时为 { canEdit: false, until: 0 }', async () => {
  const rpc = fakeRpc({
    calls: {
      [`${NET.registry}:${SEL.canEdit}`]: () => ret(0),
      [`${NET.registry}:${SEL.operatorUntil}`]: () => ret(0),
    },
  });
  assert.deepEqual(await createChain(rpc, NET).operatorState(CONTAINER, OPERATOR), { canEdit: false, until: 0 });
});

test('gasPrice 返回 bigint', async () => {
  const rpc = fakeRpc({ handlers: { eth_gasPrice: () => '0x3b9aca00' } });
  assert.equal(await createChain(rpc, NET).gasPrice(), 1000000000n);
});

test('nonceOf 同时读 latest 和 pending', async () => {
  const rpc = fakeRpc({ handlers: { eth_getTransactionCount: ([, tag]) => (tag === 'pending' ? '0x5' : '0x3') } });
  assert.deepEqual(await createChain(rpc, NET).nonceOf(OPERATOR), { latest: 3n, pending: 5n });
  assert.deepEqual(rpc.log.map((l) => l.params), [[OPERATOR, 'latest'], [OPERATOR, 'pending']]);
});

test('estimateGas 把 bigint 字段转成十六进制、去掉 undefined', async () => {
  let sent;
  const rpc = fakeRpc({ handlers: { eth_estimateGas: ([tx]) => { sent = tx; return '0x5208'; } } });
  const gas = await createChain(rpc, NET).estimateGas({ from: OPERATOR, to: CONTAINER, value: 10n ** 18n, data: '0xabcd', gas: undefined });
  assert.equal(gas, 21000n);
  assert.deepEqual(sent, { from: OPERATOR, to: CONTAINER, value: '0xde0b6b3a7640000', data: '0xabcd' });
});

test('receipt 解析状态、区块号、gas', async () => {
  const rpc = fakeRpc({
    handlers: {
      eth_getTransactionReceipt: ([h]) => (h === '0xaa'
        ? { status: '0x1', blockNumber: '0x10', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' }
        : { status: '0x0', blockNumber: '0x11', gasUsed: '0x100' }),
    },
  });
  const chain = createChain(rpc, NET);
  assert.deepEqual(await chain.receipt('0xaa'), { status: 1, blockNumber: 16n, gasUsed: 21000n, effectiveGasPrice: 1000000000n });
  assert.deepEqual(await chain.receipt('0xbb'), { status: 0, blockNumber: 17n, gasUsed: 256n, effectiveGasPrice: null });
});

test('receipt 还没上链时返回 null', async () => {
  const rpc = fakeRpc({ handlers: { eth_getTransactionReceipt: () => null } });
  assert.equal(await createChain(rpc, NET).receipt('0xaa'), null);
});

test('sendRaw 返回交易哈希', async () => {
  const rpc = fakeRpc({ handlers: { eth_sendRawTransaction: ([raw]) => (raw === '0xf8' ? '0x' + 'ab'.repeat(32) : null) } });
  assert.equal(await createChain(rpc, NET).sendRaw('0xf8'), '0x' + 'ab'.repeat(32));
});

for (const msg of ['already known', 'Known transaction: 0xabc', 'nonce too low: next nonce 5, tx nonce 4']) {
  test(`sendRaw 遇到「${msg}」返回 { known: true }`, async () => {
    const rpc = fakeRpc({ handlers: { eth_sendRawTransaction: () => { throw new RpcError(msg, -32000); } } });
    assert.deepEqual(await createChain(rpc, NET).sendRaw('0xf8'), { known: true });
  });
}

test('sendRaw 其他错误照常抛出', async () => {
  const rpc = fakeRpc({ handlers: { eth_sendRawTransaction: () => { throw new RpcError('insufficient funds for gas * price + value', -32000); } } });
  await assert.rejects(createChain(rpc, NET).sendRaw('0xf8'), /insufficient funds/);
});

test('safeBlock 返回 safe 区块号', async () => {
  const rpc = fakeRpc({ handlers: { eth_getBlockByNumber: ([tag, full]) => (tag === 'safe' && full === false ? { number: '0x64' } : null) } });
  assert.equal(await createChain(rpc, NET).safeBlock(), 100n);
});

test('safeBlock 节点不支持 safe 时返回 null', async () => {
  const bad = fakeRpc({ handlers: { eth_getBlockByNumber: () => { throw new RpcError('invalid block tag', -32602); } } });
  assert.equal(await createChain(bad, NET).safeBlock(), null);
  const empty = fakeRpc({ handlers: { eth_getBlockByNumber: () => null } });
  assert.equal(await createChain(empty, NET).safeBlock(), null);
});
