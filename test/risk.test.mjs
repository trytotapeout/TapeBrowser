import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyzer, formatUnits } from '../src/main/risk.js';
import { encodeCall } from '../src/main/abi.js';
import { BSC, XLAYER, BASE } from '../src/main/config.js';

const USDT = '0x55d398326f99059ff775485246999027b3197955';
const NFT = '0x00000000000000000000000000000000000000aa';
const SPENDER = '0x1111111111111111111111111111111111111111';
const ME = '0x2222222222222222222222222222222222222222';
const MAX = (1n << 256n) - 1n;
const tokens = { [USDT]: { symbol: 'USDT', decimals: 18 }, [NFT]: { symbol: 'PUNK', decimals: null } };
const { analyze } = createAnalyzer({ tokenInfo: async (a) => tokens[a.toLowerCase()] ?? null });
const tx = (to, data, value) => analyze('eth_sendTransaction', [{ from: ME, to, data, value }], { net: BSC });

test('formatUnits：按精度显示，小数最多 8 位', () => {
  assert.equal(formatUnits(1500000n, 6), '1.5');
  assert.equal(formatUnits(10n ** 18n, 18), '1');
  assert.equal(formatUnits(123456789123456789n, 18), '0.12345678');
  assert.equal(formatUnits('0x0', 18), '0');
});

test('无限额授权代币是高危，有限额是留意，0 是取消授权', async () => {
  const inf = await tx(USDT, encodeCall('0x095ea7b3', ['address', 'uint'], [SPENDER, MAX]));
  assert.equal(inf.level, 'danger');
  assert.match(inf.title, /无限额授权 USDT/);
  assert.match(inf.lines.join('\n'), new RegExp(SPENDER));
  const some = await tx(USDT, encodeCall('0x095ea7b3', ['address', 'uint'], [SPENDER, 25n * 10n ** 17n]));
  assert.equal(some.level, 'warn');
  assert.match(some.title, /授权 2\.5 USDT/);
  assert.equal((await tx(USDT, encodeCall('0x095ea7b3', ['address', 'uint'], [SPENDER, 0n]))).level, 'info');
});

test('NFT：授权单个是留意，setApprovalForAll 是高危，取消是普通', async () => {
  const one = await tx(NFT, encodeCall('0x095ea7b3', ['address', 'uint'], [SPENDER, 7n]));
  assert.equal(one.level, 'warn');
  assert.match(one.title, /NFT #7/);
  const all = await tx(NFT, encodeCall('0xa22cb465', ['address', 'bool'], [SPENDER, true]));
  assert.equal(all.level, 'danger');
  assert.equal((await tx(NFT, encodeCall('0xa22cb465', ['address', 'bool'], [SPENDER, false]))).level, 'info');
});

test('转账：金额按链显示原生币单位，代币按精度显示', async () => {
  const bnb = await tx(SPENDER, '0x', '0xde0b6b3a7640000');
  assert.match(bnb.title, /转出 1 BNB/);
  const okb = await analyze('eth_sendTransaction', [{ to: SPENDER, value: '0xde0b6b3a7640000' }], { net: XLAYER });
  assert.match(okb.title, /1 OKB/);
  const eth = await analyze('eth_sendTransaction', [{ to: SPENDER, value: '0xde0b6b3a7640000' }], { net: BASE });
  assert.match(eth.title, /1 ETH/);
  const usdt = await tx(USDT, encodeCall('0xa9059cbb', ['address', 'uint'], [SPENDER, 3n * 10n ** 18n]));
  assert.match(usdt.title, /转出 3 USDT/);
});

test('无法解读的合约调用提示留意；读不到代币信息时显示原始数额', async () => {
  const r = await tx(SPENDER, '0xdeadbeef00');
  assert.equal(r.level, 'warn');
  assert.match(r.title, /无法解读/);
  assert.match(r.raw, /0xdeadbeef00/);
  const unknown = '0x3333333333333333333333333333333333333333';
  const t = await tx(unknown, encodeCall('0xa9059cbb', ['address', 'uint'], [SPENDER, 5n]));
  assert.match(t.title, /5（代币合约/);
});

test('离线签名：Permit、Permit2、Seaport 挂单都是高危；普通结构化数据是留意', async () => {
  const sign = (data) => analyze('eth_signTypedData_v4', [ME, JSON.stringify(data)]);
  const permit = await sign({ primaryType: 'Permit', domain: { name: 'USD Tether', verifyingContract: USDT }, message: { owner: ME, spender: SPENDER, value: MAX.toString() } });
  assert.equal(permit.level, 'danger');
  assert.match(permit.title, /无限额/);
  assert.match(permit.lines.join('\n'), /离线签名/);
  const p2 = await sign({ primaryType: 'PermitSingle', domain: {}, message: { details: { token: USDT, amount: '1000000000000000000' }, spender: SPENDER } });
  assert.equal(p2.level, 'danger');
  assert.match(p2.lines.join('\n'), /1 USDT/);
  const sea = await sign({ primaryType: 'OrderComponents', domain: { name: 'Seaport' }, message: { offer: [{}], consideration: [] } });
  assert.equal(sea.level, 'danger');
  const plain = await sign({ primaryType: 'Mail', domain: { name: 'Demo' }, message: { text: 'hi' } });
  assert.equal(plain.level, 'warn');
});

test('personal_sign 显示文字是普通；eth_sign 盲签是高危', async () => {
  const msg = await analyze('personal_sign', ['0x' + Buffer.from('你好').toString('hex'), ME]);
  assert.equal(msg.level, 'info');
  assert.equal(msg.raw, '你好');
  assert.equal((await analyze('eth_sign', [ME, '0x' + 'ab'.repeat(32)])).level, 'danger');
});
