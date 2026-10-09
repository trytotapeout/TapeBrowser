// 临时操作员签交易：RLP 编码 + EIP-155 legacy 签名。不依赖 Electron。
// 只签 legacy（type 0）交易：BSC 和 X Layer 都支持，和官方发布页一致。
// 签名用 @noble/secp256k1（零依赖，可恢复签名）；哈希用项目自带的 keccak。

import * as secp from '@noble/secp256k1';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { keccak256 } from './keccak.js';
import { hexToBytes, bytesToHex } from './abi.js';

// 同步签名要的哈希函数，用 Node 自带的实现
// 注意这是 noble 的进程级全局设置，和 noble 自己的 sha256/hmac 等价
secp.hashes.sha256 = (m) => new Uint8Array(createHash('sha256').update(m).digest());
secp.hashes.hmacSha256 = (k, m) => new Uint8Array(createHmac('sha256', k).update(m).digest());

const EMPTY = new Uint8Array(0);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

/** 严格解析整数字段：只收 bigint >= 0、安全非负整数、0x 十六进制串，其余一律报 bad <name> */
export function uint(name, x) {
  if (typeof x === 'bigint' && x >= 0n) return x;
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
  if (typeof x === 'string' && /^0x[0-9a-fA-F]+$/.test(x)) return BigInt(x);
  throw new Error('eth-tx: bad ' + name);
}

/** 非负 bigint → 最短大端字节（0 是空串） */
function intBytes(v) {
  if (v === 0n) return EMPTY;
  const h = v.toString(16);
  return hexToBytes(h.length % 2 ? '0' + h : h);
}

function lenPrefix(len, short) {
  if (len < 56) return Uint8Array.of(short + len);
  const l = intBytes(BigInt(len));
  return concat(Uint8Array.of(short + 55 + l.length), l);
}

/** RLP 编码：Uint8Array 是字符串，数组是列表 */
export function rlp(x) {
  if (x instanceof Uint8Array) return x.length === 1 && x[0] < 0x80 ? x : concat(lenPrefix(x.length, 0x80), x);
  const body = concat(...x.map(rlp));
  return concat(lenPrefix(body.length, 0xc0), body);
}

/** 新的临时私钥（32 字节，保证在曲线范围内） */
export function newKey() {
  for (;;) {
    const k = new Uint8Array(randomBytes(32));
    if (secp.utils.isValidSecretKey(k)) return k;
  }
}

/** 私钥 → 地址（小写 0x…） */
export const addressOf = (sk) => bytesToHex(keccak256(secp.getPublicKey(sk, false).subarray(1)).subarray(12));

/**
 * 签一笔 legacy 交易。tx = {nonce, gasPrice, gas, to, value, data, chainId}，数值可以是 number / bigint / 0x 字符串。
 * 返回 {sighash, raw, hash}：raw 交给 eth_sendRawTransaction，hash 是交易哈希
 */
export function signLegacy(sk, tx) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to || '')) throw new Error('eth-tx: bad to');
  const chainId = uint('chainId', tx.chainId);
  if (chainId <= 0n) throw new Error('eth-tx: bad chainId');
  const value = tx.value === undefined ? 0n : uint('value', tx.value);
  const base = [
    intBytes(uint('nonce', tx.nonce)), intBytes(uint('gasPrice', tx.gasPrice)), intBytes(uint('gas', tx.gas)),
    hexToBytes(tx.to), intBytes(value), hexToBytes(tx.data || '0x'),
  ];
  const sighash = keccak256(rlp([...base, intBytes(chainId), EMPTY, EMPTY]));
  // recovered 格式：第 0 字节是恢复位，后面是 r(32) s(32)；默认 lowS，和以太坊一致
  const sig = secp.sign(sighash, sk, { prehash: false, format: 'recovered' });
  if (sig[0] > 1) throw new Error('eth-tx: unexpected recovery bit');
  const v = chainId * 2n + 35n + BigInt(sig[0]);
  const r = BigInt(bytesToHex(sig.subarray(1, 33)));
  const s = BigInt(bytesToHex(sig.subarray(33, 65)));
  const raw = rlp([...base, intBytes(v), intBytes(r), intBytes(s)]);
  return { sighash: bytesToHex(sighash), raw: bytesToHex(raw), hash: bytesToHex(keccak256(raw)) };
}
