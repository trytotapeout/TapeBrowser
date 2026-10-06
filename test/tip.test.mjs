import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBem, tipCallData, executeFee, prepareTip, FEE_ERROR } from '../src/main/tip.js';
import { BSC, XLAYER } from '../src/main/config.js';

const ME = '0x937a5d2985a94f900e5ab00eaebaf5271d98d743';
const ID = { network: 'bnb', networkName: 'BNB Chain', container: '0x44a6d0956866d848ed76693cec883884b32c1de9', owner: ME, opened: true };
const SITE = { network: 'bnb', container: '0x3104dccd0000000000000000000000006afff20a', opened: true };
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
// 不带手续费时报「手续费不够」，带够了就成功
const rpcWithFee = (fee) => { const calls = []; const rpc = async (_m, [tx]) => { calls.push(tx); if (BigInt(tx.value) < fee) throw Object.assign(new Error('execution reverted'), { code: 3, data: FEE_ERROR + word(tx.value) + word(fee) }); return '0x'; }; rpc.calls = calls; return rpc; };

test('parseBem：按 8 位精度换算，拒绝不合法的数额', () => {
  assert.equal(parseBem('1'), 100000000n);
  assert.equal(parseBem('0.01'), 1000000n);
  assert.equal(parseBem(' 1.5 '), 150000000n);
  for (const bad of ['', '0', '0.000000001', '-1', 'abc', '1e3']) assert.throws(() => parseBem(bad));
});

test('打赏交易：从身份容器 execute BEM.transfer 到网站容器，附带合约要求的手续费', async () => {
  const rpc = rpcWithFee(200000000000000n);
  const r = await prepareTip({ rpc, net: BSC, identity: ID, site: SITE, account: ME, amount: 1000000n, balance: '1000000' });
  assert.equal(r.fee, 200000000000000n);
  assert.deepEqual(r.tx, { from: ME, to: ID.container, value: '0xb5e620f48000', data: tipCallData(BSC.bem, SITE.container, 1000000n) });
  // 先不带手续费读出数额，再带上手续费确认能成功
  assert.deepEqual(rpc.calls.map((c) => c.value), ['0x0', '0xb5e620f48000']);
  assert.ok(r.tx.data.startsWith('0x51945447'));
  assert.ok(r.tx.data.includes(BSC.bem.slice(2)));
  assert.ok(r.tx.data.includes(SITE.container.slice(2)));
});

test('打赏前的检查：没登录、跨链、不是持有人、打赏自己、余额不够、网站没开通', async () => {
  const rpc = rpcWithFee(1n);
  const base = { rpc, net: BSC, identity: ID, site: SITE, account: ME, amount: 1000000n, balance: '1000000' };
  const cases = [
    [{ identity: null }, /登录/],
    [{ identity: { ...ID, opened: false } }, /身份的容器还没开通/],
    [{ site: { ...SITE, opened: false } }, /网站没有开通容器/],
    [{ net: XLAYER, site: { ...SITE, network: 'xlayer' } }, /同一条链/],
    [{ account: '0x1111111111111111111111111111111111111111' }, /持有人/],
    [{ site: { ...SITE, container: ID.container.toUpperCase().replace('0X', '0x') } }, /自己/],
    [{ amount: 2000000n }, /不够/],
  ];
  for (const [over, re] of cases) await assert.rejects(prepareTip({ ...base, ...over }), re);
});

test('executeFee：不需要手续费返回 0；别的报错原样抛出', async () => {
  assert.equal(await executeFee(async () => '0x', { from: ME, container: ID.container, data: '0x' }), 0n);
  await assert.rejects(executeFee(async () => { throw Object.assign(new Error('NotOwner'), { data: '0x30cd7471' }); }, { from: ME, container: ID.container, data: '0x' }), /NotOwner/);
});
