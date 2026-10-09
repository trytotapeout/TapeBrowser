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

test('operatorState 任一子调用失败时抛出，不当成没有授权', async () => {
  const noUntil = fakeRpc({ calls: { [`${NET.registry}:${SEL.canEdit}`]: () => ret(1) } });
  await assert.rejects(createChain(noUntil, NET).operatorState(CONTAINER, OPERATOR), /读不到操作员授权状态/);
  const noEdit = fakeRpc({ calls: { [`${NET.registry}:${SEL.operatorUntil}`]: () => ret(5) } });
  await assert.rejects(createChain(noEdit, NET).operatorState(CONTAINER, OPERATOR), /读不到操作员授权状态/);
});

test('operatorState 按传入的区块读', async () => {
  const rpc = fakeRpc({
    calls: {
      [`${NET.registry}:${SEL.canEdit}`]: () => ret(1),
      [`${NET.registry}:${SEL.operatorUntil}`]: () => ret(9),
    },
  });
  await createChain(rpc, NET).operatorState(CONTAINER, OPERATOR, '0x10');
  assert.equal(rpc.log[0].params[1], '0x10');
});

test('gasPrice 返回 bigint', async () => {
  const rpc = fakeRpc({ handlers: { eth_gasPrice: () => '0x3b9aca00' } });
  assert.equal(await createChain(rpc, NET).gasPrice(), 1000000000n);
});

test('nonceOf 没有 rpc.distinct 时各读一次 latest 和 pending', async () => {
  const rpc = fakeRpc({ handlers: { eth_getTransactionCount: ([, tag]) => (tag === 'pending' ? '0x5' : '0x3') } });
  assert.deepEqual(await createChain(rpc, NET).nonceOf(OPERATOR), { latest: 3n, pending: 5n, nodes: 1 });
  assert.deepEqual(rpc.log.map((l) => l.params).sort(), [[OPERATOR, 'latest'], [OPERATOR, 'pending']]);
});

test('nonceOf 用 rpc.distinct 读两个节点，取最大值', async () => {
  const rpc = fakeRpc();
  const asked = [];
  rpc.distinct = async (method, params, n) => {
    asked.push([method, params, n]);
    return params[1] === 'latest'
      ? [{ url: 'a', result: '0x7' }, { url: 'b', result: '0x4' }]
      : [{ url: 'a', result: '0x7' }, { url: 'b', result: '0x9' }];
  };
  assert.deepEqual(await createChain(rpc, NET).nonceOf(OPERATOR), { latest: 7n, pending: 9n, nodes: 2 });
  assert.deepEqual(asked.sort(), [
    ['eth_getTransactionCount', [OPERATOR, 'latest'], 2],
    ['eth_getTransactionCount', [OPERATOR, 'pending'], 2],
  ]);
  assert.equal(rpc.log.length, 0);
});

test('nonceOf 的 rpc.distinct 只有一个节点时 nodes 为 1；没有结果时退回 rpc', async () => {
  const one = fakeRpc();
  one.distinct = async () => [{ url: 'a', result: '0x2' }];
  assert.deepEqual(await createChain(one, NET).nonceOf(OPERATOR), { latest: 2n, pending: 2n, nodes: 1 });

  const none = fakeRpc({ handlers: { eth_getTransactionCount: ([, tag]) => (tag === 'pending' ? '0x6' : '0x6') } });
  none.distinct = async () => [];
  assert.deepEqual(await createChain(none, NET).nonceOf(OPERATOR), { latest: 6n, pending: 6n, nodes: 1 });
  assert.equal(none.log.length, 2);
});

test('estimateGas 把 bigint 字段转成十六进制、去掉 undefined', async () => {
  let sent;
  const rpc = fakeRpc({ handlers: { eth_estimateGas: ([tx]) => { sent = tx; return '0x5208'; } } });
  const gas = await createChain(rpc, NET).estimateGas({ from: OPERATOR, to: CONTAINER, value: 10n ** 18n, data: '0xabcd', gas: undefined });
  assert.equal(gas, 21000n);
  assert.deepEqual(sent, { from: OPERATOR, to: CONTAINER, value: '0xde0b6b3a7640000', data: '0xabcd' });
});

test('estimateGas 把数字形式的 value / gas / gasPrice / nonce 也转成十六进制', async () => {
  let sent;
  const rpc = fakeRpc({ handlers: { eth_estimateGas: ([tx]) => { sent = tx; return '0x5208'; } } });
  await createChain(rpc, NET).estimateGas({ from: OPERATOR, to: CONTAINER, value: 0, gas: 30000, gasPrice: 1000000000, nonce: 3, data: '0x' });
  assert.deepEqual(sent, { from: OPERATOR, to: CONTAINER, value: '0x0', gas: '0x7530', gasPrice: '0x3b9aca00', nonce: '0x3', data: '0x' });
});

test('receipt 解析哈希、状态、区块号、gas', async () => {
  const rpc = fakeRpc({
    handlers: {
      eth_getTransactionReceipt: ([h]) => (h === '0xaa'
        ? { transactionHash: '0xAA' + 'Cd'.repeat(31), status: '0x1', blockNumber: '0x10', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' }
        : { transactionHash: '0x' + 'bb'.repeat(32), status: '0x0', blockNumber: '0x11', gasUsed: '0x100' }),
    },
  });
  const chain = createChain(rpc, NET);
  assert.deepEqual(await chain.receipt('0xaa'), { transactionHash: '0xaa' + 'cd'.repeat(31), status: 1, blockNumber: 16n, gasUsed: 21000n, effectiveGasPrice: 1000000000n });
  assert.deepEqual(await chain.receipt('0xbb'), { transactionHash: '0x' + 'bb'.repeat(32), status: 0, blockNumber: 17n, gasUsed: 256n, effectiveGasPrice: null });
});

test('receipt 还没上链时返回 null', async () => {
  const rpc = fakeRpc({ handlers: { eth_getTransactionReceipt: () => null } });
  assert.equal(await createChain(rpc, NET).receipt('0xaa'), null);
});

test('sendRaw 返回交易哈希', async () => {
  const rpc = fakeRpc({ handlers: { eth_sendRawTransaction: ([raw]) => (raw === '0xf8' ? '0x' + 'ab'.repeat(32) : null) } });
  assert.equal(await createChain(rpc, NET).sendRaw('0xf8'), '0x' + 'ab'.repeat(32));
});

for (const [msg, reason] of [
  ['already known', 'pending'],
  ['Known transaction: 0xabc', 'pending'],
  ['transaction already imported', 'pending'],
  ['tx already exists in cache', 'pending'],
  ['nonce too low: next nonce 5, tx nonce 4', 'nonceUsed'],
  ['Nonce too low', 'nonceUsed'],
]) {
  test(`sendRaw 遇到「${msg}」返回 { known: true, reason: '${reason}' }`, async () => {
    const rpc = fakeRpc({ handlers: { eth_sendRawTransaction: () => { throw new RpcError(msg, -32000); } } });
    assert.deepEqual(await createChain(rpc, NET).sendRaw('0xf8'), { known: true, reason });
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
  const cases = [
    new RpcError('invalid block tag', -32000),
    new RpcError('whatever', -32602),
    new RpcError('the method eth_getBlockByNumber does not exist', -32601),
    new RpcError('safe block not found', -32000),
    new RpcError('tag not supported', -32000),
  ];
  for (const err of cases) {
    const bad = fakeRpc({ handlers: { eth_getBlockByNumber: () => { throw err; } } });
    assert.equal(await createChain(bad, NET).safeBlock(), null, err.message);
  }
  const empty = fakeRpc({ handlers: { eth_getBlockByNumber: () => null } });
  assert.equal(await createChain(empty, NET).safeBlock(), null);
});

test('safeBlock 其他节点错误照常抛出', async () => {
  const rpc = fakeRpc({ handlers: { eth_getBlockByNumber: () => { throw new RpcError('RPC timeout', -32603); } } });
  await assert.rejects(createChain(rpc, NET).safeBlock(), /RPC timeout/);
  const http = fakeRpc({ handlers: { eth_getBlockByNumber: () => { throw new RpcError('HTTP 502', -32603); } } });
  await assert.rejects(createChain(http, NET).safeBlock(), /HTTP 502/);
});
