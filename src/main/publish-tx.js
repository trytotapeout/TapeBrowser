// 发布到容器要用的交易：持有人签的（开通、授权、撤销、充值）和临时操作员签的（上传、退款）。纯函数，不依赖 Electron。
// 数值一律是 bigint；交给钱包前由调用方转成 0x 十六进制。

import { encodeCall } from './abi.js';
import { SEL, OPERATOR_TTL, MAX_GAS_PRICE, MAX_UPLOAD_GAS } from './config.js';
import { chunkOf } from './publish-plan.js';

const ZERO = '0x' + '0'.repeat(40);
const lower = (a) => String(a).toLowerCase();

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
  if (BigInt(tx.chainId) !== BigInt(net.chainId)) fail();
  const gas = BigInt(tx.gas);
  const price = BigInt(tx.gasPrice);
  if (gas <= 0n || gas > MAX_UPLOAD_GAS || price <= 0n || price > MAX_GAS_PRICE) fail();
  if (refund) {
    if (lower(tx.to) !== lower(op.owner) || (tx.data || '0x') !== '0x' || BigInt(tx.value) <= 0n) fail();
    return;
  }
  const sel = String(tx.data).slice(0, 10);
  if (lower(tx.to) !== lower(net.registry) || BigInt(tx.value ?? 0) !== 0n) fail();
  if (sel !== SEL.putFile && sel !== SEL.appendChunk) fail();
  // 第一个参数（容器地址）在 calldata 的 10..74 位，地址占后 40 位
  if ('0x' + lower(tx.data.slice(34, 74)) !== lower(op.container)) fail();
}
