import test from 'node:test';
import assert from 'node:assert/strict';
import { createBemBalances, formatBem } from '../src/main/bem.js';

const NETS = [
  { key: 'bnb', name: 'BNB Chain', bem: '0xbem1' },
  { key: 'xlayer', name: 'X Layer', bem: '0xbem2' },
  { key: 'base', name: 'Base', bem: null },
];
const chain = (fn) => ({ tokenBalance: fn });
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
  assert.equal(b.view(), null, '没连钱包不显示');
  b.setAccount('0xABC');
  await tick(); await tick();
  const v = b.view();
  b.stop();
  assert.deepEqual(asked, [['bnb', '0xbem1', '0xabc']]);
  assert.equal(v.total, '3');
  assert.deepEqual(v.networks.map((n) => [n.key, n.balance, Boolean(n.error)]), [['bnb', '3', false], ['xlayer', null, true]]);
  assert.equal(views[0].loading, true, '先推一次「读取中」');
});

test('换地址或断开时丢掉旧结果', async () => {
  let release;
  const chains = { bnb: chain(() => new Promise((r) => { release = r; })), xlayer: chain(async () => 0n) };
  const b = createBemBalances({ chains, networks: NETS });
  b.setAccount('0xa');
  b.setAccount(null);
  release(999n);
  await tick();
  assert.equal(b.view(), null);
  b.stop();
});
