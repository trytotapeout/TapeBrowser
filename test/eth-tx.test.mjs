import test from 'node:test';
import assert from 'node:assert/strict';
import { rlp, signLegacy, addressOf, newKey } from '../src/main/eth-tx.js';
import { hexToBytes, bytesToHex } from '../src/main/abi.js';

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
  assert.throws(() => signLegacy(sk, { ...ok, nonce: -1 }), /negative/);
  assert.throws(() => signLegacy(sk, { ...ok, chainId: 0 }), /chainId/);
});
