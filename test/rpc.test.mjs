import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpcPool } from '../src/main/rpc.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('429 与网络错误换下一个节点重试', async () => {
  const hits = [];
  const fetchImpl = async (url) => {
    hits.push(url);
    if (url === 'a') return json(429, {});
    if (url === 'b') throw new Error('ECONNRESET');
    return json(200, { jsonrpc: '2.0', id: 1, result: '0x10' });
  };
  const rpc = createRpcPool(() => ['a', 'b', 'c'], { fetchImpl });
  assert.equal(await rpc('eth_blockNumber'), '0x10');
  assert.deepEqual(hits, ['a', 'b', 'c']);
  // 之后从可用节点开始
  await rpc('eth_blockNumber');
  assert.equal(hits.at(-1), 'c');
});

test('合约 revert 不重试，原样抛出', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return json(200, { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } }); };
  const rpc = createRpcPool(() => ['a', 'b'], { fetchImpl });
  await assert.rejects(rpc('eth_call', []), (e) => e.code === 3 && e.data === '0x08c379a0');
  assert.equal(n, 1);
});

test('全部失败时抛出最后一个错误', async () => {
  const rpc = createRpcPool(() => ['a'], { fetchImpl: async () => json(503, {}), rounds: 2 });
  await assert.rejects(rpc('eth_blockNumber'), /HTTP 503/);
});

test('超时', async () => {
  const rpc = createRpcPool(() => ['a'], { fetchImpl: () => new Promise(() => {}), timeoutMs: 20, rounds: 1 });
  await assert.rejects(rpc('eth_blockNumber'), /timeout/);
});
