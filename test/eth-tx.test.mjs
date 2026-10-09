import test from 'node:test';
import assert from 'node:assert/strict';
import { rlp, signLegacy, addressOf, newKey } from '../src/main/eth-tx.js';
import { hexToBytes, bytesToHex } from '../src/main/abi.js';
import { keccak256 } from '../src/main/keccak.js';
import * as secp from '@noble/secp256k1';

const hex = (b) => bytesToHex(b);

test('RLP：空列表、空串、单字节、短串、长串', () => {
  assert.equal(hex(rlp([])), '0xc0');
  assert.equal(hex(rlp(new Uint8Array(0))), '0x80');
  assert.equal(hex(rlp(Uint8Array.of(0x7f))), '0x7f');
  assert.equal(hex(rlp(Uint8Array.of(0x80))), '0x8180');
  assert.equal(hex(rlp(new TextEncoder().encode('dog'))), '0x83646f67');
  assert.equal(hex(rlp(new Uint8Array(1024)).subarray(0, 3)), '0xb90400');
});

test('私钥 → 地址：私钥 1 对应 0x7e5f…5bdf', () => {
  assert.equal(addressOf(hexToBytes('00'.repeat(31) + '01')), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
});

test('EIP-155 官方向量：sighash、raw、hash', () => {
  const r = signLegacy(hexToBytes('46'.repeat(32)), {
    nonce: 9, gasPrice: 20000000000n, gas: 21000, to: '0x' + '35'.repeat(20), value: 10n ** 18n, data: '0x', chainId: 1,
  });
  assert.equal(r.sighash, '0xdaf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53');
  assert.equal(r.raw, '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83');
  assert.match(r.hash, /^0x[0-9a-f]{64}$/);
});

test('newKey：32 字节、每次不同、能算出地址', () => {
  const a = newKey();
  const b = newKey();
  assert.equal(a.length, 32);
  assert.notEqual(hex(a), hex(b));
  assert.match(addressOf(a), /^0x[0-9a-f]{40}$/);
});

test('签名前拒绝不合法的字段', () => {
  const sk = hexToBytes('46'.repeat(32));
  const ok = { nonce: 0, gasPrice: 1n, gas: 21000, to: '0x' + '35'.repeat(20), value: 0n, data: '0x', chainId: 56 };
  assert.throws(() => signLegacy(sk, { ...ok, to: '0x1234' }), /to/);
  assert.throws(() => signLegacy(sk, { ...ok, nonce: -1 }), /bad nonce/);
  assert.throws(() => signLegacy(sk, { ...ok, chainId: 0 }), /chainId/);
});

test('整数字段严格校验：非安全整数、小数、空串、非 0x 串、布尔、缺失都拒绝', () => {
  const sk = hexToBytes('46'.repeat(32));
  const ok = { nonce: 0, gasPrice: 1n, gas: 21000, to: '0x' + '35'.repeat(20), value: 0n, data: '0x', chainId: 56 };
  const bad = [
    ['value', 1e30], ['gas', 1.5], ['nonce', ''], ['gasPrice', '0x'], ['value', '12'],
    ['nonce', true], ['gas', undefined], ['gasPrice', null], ['nonce', -1n], ['chainId', '56'],
  ];
  for (const [k, v] of bad) {
    assert.throws(() => signLegacy(sk, { ...ok, [k]: v }), new RegExp('eth-tx: bad ' + k), `${k}=${String(v)}`);
  }
  // 合法写法：bigint、安全整数、0x 串；value 缺省为 0
  const { value, ...noValue } = ok;
  assert.doesNotThrow(() => signLegacy(sk, noValue));
  assert.doesNotThrow(() => signLegacy(sk, { ...ok, nonce: '0x0', gasPrice: '0x3b9aca00', gas: 21000n, chainId: '0x38' }));
});

// 测试用的最小 RLP 解码器：只认字符串和列表，够解 legacy 交易
function rlpDecode(b) {
  const [item, end] = rlpItem(b, 0);
  assert.equal(end, b.length, 'RLP 尾部有多余字节');
  return item;
}
function rlpItem(b, i) {
  const p = b[i];
  if (p < 0x80) return [b.subarray(i, i + 1), i + 1];
  const readLen = (n, at) => { let l = 0; for (let k = 0; k < n; k++) l = l * 256 + b[at + k]; return l; };
  let isList, len, start;
  if (p < 0xb8) { isList = false; len = p - 0x80; start = i + 1; }
  else if (p < 0xc0) { isList = false; const n = p - 0xb7; len = readLen(n, i + 1); start = i + 1 + n; }
  else if (p < 0xf8) { isList = true; len = p - 0xc0; start = i + 1; }
  else { isList = true; const n = p - 0xf7; len = readLen(n, i + 1); start = i + 1 + n; }
  const end = start + len;
  assert.ok(end <= b.length, 'RLP 长度越界');
  if (!isList) return [b.subarray(start, end), end];
  const out = [];
  let j = start;
  while (j < end) { const [x, nj] = rlpItem(b, j); out.push(x); j = nj; }
  assert.equal(j, end);
  return [out, end];
}

const big = (b) => (b.length ? BigInt(bytesToHex(b)) : 0n);
const pad32 = (b) => { const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

test('往返：解码 raw 字段一致，恢复出的地址等于签名者，s 是 low-S', () => {
  let seed = 12345;
  const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
  for (const chainId of [56, 196]) {
    for (let k = 0; k < 20; k++) {
      const sk = newKey();
      const dataBytes = Uint8Array.from({ length: rnd(80) }, () => rnd(256));
      const tx = {
        nonce: rnd(1000), gasPrice: BigInt(rnd(1e9)) * 1000n, gas: 21000 + rnd(500000),
        to: bytesToHex(newKey().subarray(0, 20)), value: BigInt(rnd(1e9)) * 10n ** 9n,
        data: bytesToHex(dataBytes), chainId,
      };
      const r = signLegacy(sk, tx);
      const raw = hexToBytes(r.raw);
      assert.equal(bytesToHex(keccak256(raw)), r.hash);
      const f = rlpDecode(raw);
      assert.equal(f.length, 9);
      assert.equal(big(f[0]), BigInt(tx.nonce));
      assert.equal(big(f[1]), tx.gasPrice);
      assert.equal(big(f[2]), BigInt(tx.gas));
      assert.equal(bytesToHex(f[3]), tx.to);
      assert.equal(big(f[4]), tx.value);
      assert.equal(bytesToHex(f[5]), tx.data);
      const v = big(f[6]);
      const base = BigInt(chainId) * 2n + 35n;
      assert.ok(v === base || v === base + 1n, `v=${v}`);
      const s = big(f[8]);
      assert.ok(s > 0n && s <= N / 2n, 'high-S');
      const sig = Uint8Array.of(Number(v - base), ...pad32(f[7]), ...pad32(f[8]));
      const pub = secp.recoverPublicKey(sig, hexToBytes(r.sighash), { prehash: false, isCompressed: false });
      assert.equal(pub.length, 65);
      assert.equal(bytesToHex(keccak256(pub.subarray(1)).subarray(12)), addressOf(sk));
    }
  }
});
