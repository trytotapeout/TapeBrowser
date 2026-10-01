// 最小 ABI 编解码：只覆盖本项目用到的类型，零依赖，便于整站上链（DeWEB 不允许外部脚本）。
// 支持编码：uint / address / bool / string / bytes，以及 Multicall3 的 (address,bool,bytes)[]。
// 支持解码：uint / bool / address / bytes32 / bytes / string / string[]。

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_ARRAY = 100000;

export function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('abi: bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(b) {
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const padRight = (hex) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);

function encodeDynamicBytes(bytes) {
  return word(bytes.length) + padRight(bytesToHex(bytes).slice(2));
}

function encodeStatic(type, v) {
  switch (type) {
    case 'uint': return word(v);
    case 'bool': return word(v ? 1 : 0);
    case 'bytes32': {
      if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error('abi: bad bytes32');
      return v.slice(2).toLowerCase();
    }
    case 'address': {
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error('abi: bad address ' + v);
      return v.slice(2).toLowerCase().padStart(64, '0');
    }
    default: return null;
  }
}

/** 编码一个元组（顶层参数表同样按元组处理），返回不带 0x 的十六进制 */
function encodeTuple(types, values) {
  let head = '';
  let tail = '';
  const headSize = types.length * 32;
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const v = values[i];
    const s = encodeStatic(t, v);
    if (s !== null) { head += s; continue; }
    let body;
    if (t === 'string') body = encodeDynamicBytes(enc.encode(v));
    else if (t === 'bytes') body = encodeDynamicBytes(typeof v === 'string' ? hexToBytes(v) : v);
    else if (t === 'call3[]') body = encodeCall3Array(v);
    else throw new Error('abi: unsupported input type ' + t);
    head += word(headSize + tail.length / 2);
    tail += body;
  }
  return head + tail;
}

/** Multicall3 aggregate3 的参数：[{target, allowFailure, callData}] */
function encodeCall3Array(calls) {
  const items = calls.map((c) => encodeTuple(['address', 'bool', 'bytes'], [c.target, c.allowFailure, c.callData]));
  let head = '';
  let tail = '';
  for (const it of items) {
    head += word(calls.length * 32 + tail.length / 2);
    tail += it;
  }
  return word(calls.length) + head + tail;
}

/** selector 为 0x 开头的 4 字节；返回 calldata（0x…） */
export function encodeCall(selector, types = [], values = []) {
  return selector + encodeTuple(types, values);
}

// ---------------------------------------------------------------- 解码

function u256(b, off) {
  if (off + 32 > b.length) throw new Error('abi: out of bounds');
  let n = 0n;
  for (let i = off; i < off + 32; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function toOffset(n) {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('abi: offset too large');
  return Number(n);
}

function bytesAt(b, off) {
  const len = toOffset(u256(b, off));
  if (off + 32 + len > b.length) throw new Error('abi: out of bounds');
  return b.subarray(off + 32, off + 32 + len);
}

function readType(b, type, off, base) {
  switch (type) {
    case 'uint': return u256(b, off);
    case 'bool': {
      const n = u256(b, off);
      if (n > 1n) throw new Error('abi: bad bool');
      return n === 1n;
    }
    case 'address': {
      const n = u256(b, off);
      if (n >> 160n) throw new Error('abi: dirty address');
      return '0x' + n.toString(16).padStart(40, '0');
    }
    case 'bytes32': {
      if (off + 32 > b.length) throw new Error('abi: out of bounds');
      return bytesToHex(b.subarray(off, off + 32));
    }
    case 'bytes': return bytesToHex(bytesAt(b, base + toOffset(u256(b, off))));
    case 'string': return dec.decode(bytesAt(b, base + toOffset(u256(b, off))));
    case 'string[]': {
      const p = base + toOffset(u256(b, off));
      const n = toOffset(u256(b, p));
      if (n > MAX_ARRAY) throw new Error('abi: array too long');
      const start = p + 32;
      const out = [];
      for (let i = 0; i < n; i++) out.push(dec.decode(bytesAt(b, start + toOffset(u256(b, start + i * 32)))));
      return out;
    }
    default: throw new Error('abi: unsupported output type ' + type);
  }
}

/** 按顶层类型列表解码返回值 */
export function decodeResult(types, hex) {
  const b = typeof hex === 'string' ? hexToBytes(hex) : hex;
  if (b.length < types.length * 32) throw new Error('abi: short return data');
  return types.map((t, i) => readType(b, t, i * 32, 0));
}

/** 解码 aggregate3 的返回值 (bool success, bytes returnData)[] */
export function decodeAggregate3(hex) {
  const b = hexToBytes(hex);
  const p = toOffset(u256(b, 0));
  const n = toOffset(u256(b, p));
  if (n > MAX_ARRAY) throw new Error('abi: array too long');
  const start = p + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = start + toOffset(u256(b, start + i * 32));
    out.push({ success: readType(b, 'bool', t, t), returnData: readType(b, 'bytes', t + 32, t) });
  }
  return out;
}
