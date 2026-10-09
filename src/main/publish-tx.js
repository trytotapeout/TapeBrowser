// 发布到容器要用的交易：持有人签的（开通、授权、撤销、充值）和临时操作员签的（上传、退款）。纯函数，不依赖 Electron。
// 数值一律是 bigint；交给钱包前由调用方转成 0x 十六进制。

import { encodeCall } from './abi.js';
import { SEL, OPERATOR_TTL, MAX_GAS_PRICE, MAX_UPLOAD_GAS } from './config.js';
import { chunkOf } from './publish-plan.js';
import { uint } from './eth-tx.js';

const ZERO = '0x' + '0'.repeat(40);
const lower = (a) => String(a).toLowerCase();
const UPLOAD_DATA = /^0x[0-9a-f]{8}0{24}[0-9a-f]{40}(?:[0-9a-f]{2})*$/;

/** 上传一块：第 0 块 putFile（同时写类型和哈希），后面的块 appendChunk（expectIndex 防止重复追加） */
export function uploadTx(net, container, { path, index, row }) {
  const part = chunkOf(row.bytes, index);
  const data = index === 0
    ? encodeCall(SEL.putFile, ['address', 'string', 'string', 'bytes32', 'bytes'], [container, path, row.contentType, row.sha256, part])
    : encodeCall(SEL.appendChunk, ['address', 'string', 'uint', 'bytes'], [container, path, index, part]);
  return { to: net.registry, value: 0n, data };
}

/** 开通容器：value 必须等于 opener.FEE() */
export const openTx = (net, owner, { circuits, tokenId }, fee) => ({
  from: owner, to: net.opener, value: fee, data: encodeCall(SEL.open, ['address', 'uint'], [circuits, tokenId]),
});

/** 授权临时操作员编辑这个容器 OPERATOR_TTL 秒 */
export const grantTx = (net, owner, container, operator) => ({
  from: owner, to: net.registry, value: 0n, data: encodeCall(SEL.setOperator, ['address', 'address', 'uint'], [container, operator, OPERATOR_TTL]),
});

/** 撤销授权 */
export const revokeTx = (net, owner, container) => ({
  from: owner, to: net.registry, value: 0n, data: encodeCall(SEL.setOperator, ['address', 'address', 'uint'], [container, ZERO, 0]),
});

/** 持有人给临时钱包充 gas */
export const fundTx = (owner, operator, amount) => ({ from: owner, to: operator, value: amount, data: '0x' });

/** 临时钱包把余额退回持有人 */
export const refundTx = (owner, amount) => ({ to: owner, value: amount, data: '0x' });

/**
 * 临时操作员签名前的白名单。op = {address, owner, container}；tx 要带 gas / gasPrice / chainId。
 * 上传：只能调 registry 的 putFile / appendChunk、容器是本次的容器、不带原生币。
 * 退款（refund: true）：只能转给持有人、不带 data、金额大于 0。
 */
export function assertOperatorTx(op, net, tx, { refund = false } = {}) {
  const fail = () => { throw new Error('操作员交易不在允许范围内'); };
  // 数值字段和 signLegacy 用同一套严格解析，解析不了就按不在白名单处理
  let chainId, gas, price, value;
  try {
    chainId = uint('chainId', tx.chainId);
    gas = uint('gas', tx.gas);
    price = uint('gasPrice', tx.gasPrice);
    // 上传的 value 缺省当 0（和 signLegacy 一致）；退款必须给出金额
    value = !refund && tx.value === undefined ? 0n : uint('value', tx.value);
  } catch { fail(); }
  if (chainId !== BigInt(net.chainId)) fail();
  if (gas <= 0n || gas > MAX_UPLOAD_GAS || price <= 0n || price > MAX_GAS_PRICE) fail();
  if (refund) {
    if (lower(tx.to) !== lower(op.owner) || (tx.data || '0x') !== '0x' || value <= 0n) fail();
    return;
  }
  if (lower(tx.to) !== lower(net.registry) || value !== 0n) fail();
  // calldata 形状：小写、偶数长度、选择器 + 第一个参数（容器地址，前 12 字节填充必须是 0）
  if (typeof tx.data !== 'string' || !UPLOAD_DATA.test(tx.data)) fail();
  const sel = tx.data.slice(0, 10);
  if (sel !== SEL.putFile && sel !== SEL.appendChunk) fail();
  // 容器地址在 calldata 的 34..74 位。只锁容器不锁路径：按设计，操作员可以写这个容器里的任意路径
  if ('0x' + tx.data.slice(34, 74) !== lower(op.container)) fail();
}
