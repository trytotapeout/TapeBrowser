import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBem, tipCallData, prepareTip, TRANSFER } from '../src/main/tip.js';
import { BSC, BASE } from '../src/main/config.js';

const ME = '0x937a5d2985a94f900e5ab00eaebaf5271d98d743';
const SITE = { container: '0x3104dccd0000000000000000000000006afff20a', opened: true };
const fakeRpc = () => { const calls = []; const rpc = async (_m, [tx]) => { calls.push(tx); return '0x'; }; rpc.calls = calls; return rpc; };

test('parseBem：按 8 位精度换算，拒绝不合法的数额', () => {
  assert.equal(parseBem('1'), 100000000n);
  assert.equal(parseBem('0.01'), 1000000n);
  assert.equal(parseBem(' 1.5 '), 150000000n);
  for (const bad of ['', '0', '0.000000001', '-1', 'abc', '1e3']) assert.throws(() => parseBem(bad));
});

test('打赏交易：钱包直接调用 BEM.transfer 转进网站容器，不附带原生币；先在链上模拟', async () => {
  const rpc = fakeRpc();
  const r = await prepareTip({ rpc, net: BSC, site: SITE, account: ME.toUpperCase().replace('0X', '0x'), amount: 1000000n, balance: 1000000n });
  assert.deepEqual(r.tx, { from: ME, to: BSC.bem, value: '0x0', data: tipCallData(SITE.container, 1000000n) });
  assert.ok(r.tx.data.startsWith(TRANSFER));
  assert.ok(r.tx.data.includes(SITE.container.slice(2)));
  assert.ok(r.tx.data.endsWith((1000000).toString(16).padStart(64, '0')));
  assert.deepEqual(rpc.calls, [r.tx]);
});

test('打赏前的检查：没连钱包、网站没开通、链上没有 BEM、余额不够、模拟失败', async () => {
  const base = { rpc: fakeRpc(), net: BSC, site: SITE, account: ME, amount: 1000000n, balance: 1000000n };
  const cases = [
    [{ account: null }, /连接钱包/],
    [{ site: { ...SITE, opened: false } }, /没有开通容器/],
    [{ site: null }, /没有开通容器/],
    [{ net: BASE }, /没有 BEM/],
    [{ amount: 2000000n }, /不够/],
    [{ rpc: async () => { throw new Error('execution reverted'); } }, /reverted/],
  ];
  for (const [over, re] of cases) await assert.rejects(prepareTip({ ...base, ...over }), re);
  // 余额没读到时不拦，交给模拟
  await prepareTip({ ...base, balance: null, amount: 5n * 10n ** 18n });
});
