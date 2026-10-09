import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadTx, openTx, grantTx, revokeTx, fundTx, refundTx, assertOperatorTx } from '../src/main/publish-tx.js';
import { BSC, SEL, OPERATOR_TTL, MAX_GAS_PRICE, MAX_UPLOAD_GAS } from '../src/main/config.js';
import { decodeResult } from '../src/main/abi.js';

const C = '0x3104dccd0000000000000000000000006afff20a';
const OWNER = '0x937a5d2985a94f900e5ab00eaebaf5271d98d743';
const OP = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const SHA = '0x' + 'ab'.repeat(32);
const step = (index) => ({ path: 'a.js', index, row: { contentType: 'text/javascript; charset=utf-8', sha256: SHA, bytes: new Uint8Array(30000).fill(1) } });
const op = { address: OP, owner: OWNER, container: C };
const signed = (tx) => ({ ...tx, gas: 5000000n, gasPrice: 50000000n, chainId: 56 });

test('第 0 块用 putFile，带路径、类型、哈希和前 24000 字节；后面的块用 appendChunk', () => {
  const a = uploadTx(BSC, C, step(0));
  assert.equal(a.to, BSC.registry);
  assert.equal(a.value, 0n);
  assert.ok(a.data.startsWith(SEL.putFile));
  const [, path, type, hash, data] = decodeResult(['address', 'string', 'string', 'bytes32', 'bytes'], '0x' + a.data.slice(10));
  // bytes 解码出来是 0x 十六进制
  assert.deepEqual([path, type, hash, (data.length - 2) / 2], ['a.js', 'text/javascript; charset=utf-8', SHA, 24000]);
  const b = uploadTx(BSC, C, step(1));
  assert.ok(b.data.startsWith(SEL.appendChunk));
  const [, p2, idx, d2] = decodeResult(['address', 'string', 'uint', 'bytes'], '0x' + b.data.slice(10));
  assert.deepEqual([p2, idx, (d2.length - 2) / 2], ['a.js', 1n, 6000]);
});

test('持有人的交易：开通付 FEE，授权 6 小时，撤销传零地址，充值转给操作员', () => {
  const o = openTx(BSC, OWNER, { circuits: '0x' + '11'.repeat(20), tokenId: 42 }, 12000000000000000n);
  assert.deepEqual([o.from, o.to, o.value], [OWNER, BSC.opener, 12000000000000000n]);
  assert.ok(o.data.startsWith(SEL.open));
  const g = grantTx(BSC, OWNER, C, OP);
  assert.deepEqual(decodeResult(['address', 'address', 'uint'], '0x' + g.data.slice(10)), [C, OP, BigInt(OPERATOR_TTL)]);
  const r = revokeTx(BSC, OWNER, C);
  assert.deepEqual(decodeResult(['address', 'address', 'uint'], '0x' + r.data.slice(10)), [C, '0x' + '0'.repeat(40), 0n]);
  assert.deepEqual(fundTx(OWNER, OP, 5n), { from: OWNER, to: OP, value: 5n, data: '0x' });
});

test('操作员白名单：放行本容器的上传和给持有人的退款', () => {
  assertOperatorTx(op, BSC, signed(uploadTx(BSC, C, step(0))));
  assertOperatorTx(op, BSC, signed(uploadTx(BSC, C, step(1))));
  assertOperatorTx(op, BSC, { ...refundTx(OWNER, 10n), gas: 21000n, gasPrice: 50000000n, chainId: 56 }, { refund: true });
});

test('操作员白名单：拒绝别的合约、别的容器、别的函数、带币、gas 超限、退款给别人', () => {
  const up = signed(uploadTx(BSC, C, step(0)));
  const other = '0x' + '22'.repeat(20);
  const bad = [
    { ...up, to: other },
    { ...up, data: uploadTx(BSC, other, step(0)).data },
    { ...up, data: grantTx(BSC, OWNER, C, other).data },
    { ...up, value: 1n },
    { ...up, gas: 15000001n },
    { ...up, gasPrice: MAX_GAS_PRICE + 1n },
    { ...up, chainId: 196 },
  ];
  for (const tx of bad) assert.throws(() => assertOperatorTx(op, BSC, tx), /操作员/);
  const refund = { ...refundTx(OWNER, 10n), gas: 21000n, gasPrice: 1n, chainId: 56 };
  assert.throws(() => assertOperatorTx(op, BSC, { ...refund, to: other }, { refund: true }), /操作员/);
  assert.throws(() => assertOperatorTx(op, BSC, { ...refund, data: '0x00' }, { refund: true }), /操作员/);
  assert.throws(() => assertOperatorTx(op, BSC, { ...refund, value: 0n }, { refund: true }), /操作员/);
});

test('操作员白名单：字段缺失或格式不严格一律拒绝', () => {
  const up = signed(uploadTx(BSC, C, step(0)));
  const ap = signed(uploadTx(BSC, C, step(1)));
  const other = '0x' + '22'.repeat(20);
  const { gas, gasPrice, chainId, ...noNums } = up;
  const bad = [
    { ...ap, data: uploadTx(BSC, other, step(1)).data },
    { ...up, gas: 0n },
    { ...up, gasPrice: 0n },
    { ...noNums, gasPrice, chainId },
    { ...noNums, gas, chainId },
    { ...noNums, gas, gasPrice },
    { ...up, chainId: '56' },
    { ...up, data: '0x' + up.data.slice(2).toUpperCase() },
    { ...up, data: '0X' + up.data.slice(2) },
    { ...up, data: up.data.slice(0, 73) },
    { ...up, data: undefined },
    // 容器地址前面的 12 字节填充不是 0
    { ...up, data: up.data.slice(0, 10) + 'ff' + up.data.slice(12) },
  ];
  for (const tx of bad) assert.throws(() => assertOperatorTx(op, BSC, tx), /操作员/);
  const { value, ...refundNoValue } = { ...refundTx(OWNER, 10n), gas: 21000n, gasPrice: 1n, chainId: 56 };
  assert.throws(() => assertOperatorTx(op, BSC, refundNoValue, { refund: true }), /操作员/);
});

test('操作员白名单：value 缺省当 0、上限边界值、十六进制 chainId 都放行', () => {
  const { value, ...up } = signed(uploadTx(BSC, C, step(0)));
  assertOperatorTx(op, BSC, up);
  assertOperatorTx(op, BSC, { ...up, gas: MAX_UPLOAD_GAS, gasPrice: MAX_GAS_PRICE });
  assertOperatorTx(op, BSC, { ...up, chainId: '0x38' });
});
