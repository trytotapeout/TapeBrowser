import test from 'node:test';
import assert from 'node:assert/strict';
import { createBemBalances, formatBem } from '../src/main/bem.js';

const NETS = [
  { key: 'bnb', name: 'BNB Chain', bem: '0xbem1', bemPricePool: { pool: '0xpool', quoteDecimals: 18 } },
  { key: 'xlayer', name: 'X Layer', bem: '0xbem2' },
  { key: 'base', name: 'Base', bem: null },
];
const chain = (fn, price = async () => 27.5) => ({ tokenBalance: fn, v3Price: price });
const tick = () => new Promise((r) => setImmediate(r));

test('formatBem：8 位精度，最多 2 位小数，千分位', () => {
  assert.equal(formatBem(123456789012n), '1,234.56');
  assert.equal(formatBem(100000000n), '1');
  assert.equal(formatBem(150000000n), '1.5');
  assert.equal(formatBem(0n), '0');
});

test('汇总各链余额；没有 BEM 的链不查；一条链失败只影响它自己', async () => {
  const asked = [];
  const chains = {
    bnb: chain(async (t, a) => { asked.push(['bnb', t, a]); return 300000000n; }),
    xlayer: chain(async () => { throw new Error('rpc down'); }),
    base: chain(async () => { asked.push(['base']); return 1n; }),
  };
  const views = [];
  const b = createBemBalances({ chains, networks: NETS, onChange: (v) => views.push(v) });
  assert.deepEqual(b.view(), { price: null, balance: null }, '没连钱包不显示余额');
  b.setAccount('0xABC');
  await tick(); await tick(); await tick();
  const view = b.view();
  b.stop();
  assert.equal(view.price, 27.5);
  const v = view.balance;
  assert.equal(v.usd, 3 * 27.5, '余额折合美元');
  assert.deepEqual(asked, [['bnb', '0xbem1', '0xabc']]);
  assert.equal(v.total, '3');
  assert.deepEqual(v.networks.map((n) => [n.key, n.balance, Boolean(n.error)]), [['bnb', '3', false], ['xlayer', null, true]]);
  assert.equal(views[0].balance.loading, true, '先推一次「读取中」');
});

test('换地址或断开时丢掉旧结果', async () => {
  let release;
  const chains = { bnb: chain(() => new Promise((r) => { release = r; })), xlayer: chain(async () => 0n) };
  const b = createBemBalances({ chains, networks: NETS });
  b.setAccount('0xa');
  // 先读价格再读余额：等余额请求发出去
  await tick(); await tick();
  b.setAccount(null);
  release(999n);
  await tick();
  assert.equal(b.view().balance, null);
  b.stop();
});

test('没连钱包也能显示价格；价格读不到时余额照常显示，不折合美元', async () => {
  const pools = [];
  const chains = { bnb: chain(async () => 100000000n, async (pool, token, d, qd) => { pools.push([pool, token, d, qd]); return 27.04; }), xlayer: chain(async () => 0n) };
  const b = createBemBalances({ chains, networks: NETS });
  b.start();
  await tick(); await tick();
  assert.deepEqual(b.view(), { price: 27.04, balance: null });
  assert.deepEqual(pools[0], ['0xpool', '0xbem1', 8, 18]);
  b.stop();
  const bad = createBemBalances({ chains: { bnb: chain(async () => 100000000n, async () => { throw new Error('rpc'); }), xlayer: chain(async () => 0n) }, networks: NETS });
  bad.setAccount('0xa');
  await tick(); await tick(); await tick();
  const v = bad.view();
  bad.stop();
  assert.equal(v.price, null);
  assert.equal(v.balance.total, '1');
  assert.equal(v.balance.usd, null);
});
