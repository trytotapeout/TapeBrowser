# 本地预览发布到容器 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把本地预览的文件夹发布到钱包名下某个电路的容器：选链 → 选电路（未开通可先开通）→ 临时操作员自动上传 → 回读核验 → 退回余额 → 打开网站。

**Architecture:** 链上规则全部做成不依赖 Electron 的纯模块（发布计划、交易数据、交易签名），用 node:test 覆盖；再加一个可注入 rpc / 签名 / 持有人发交易的发布引擎；最后接 main.js 的 IPC 和界面。持有人的交易（开通、授权、充值）经桥接页交给钱包扩展，上传交易由主进程里的临时操作员签名后 `eth_sendRawTransaction` 广播。

**Tech Stack:** Electron 44、Node ESM、node:test、项目自带的 abi.js / keccak.js，新增唯一依赖 `@noble/secp256k1@3.2.0`（零依赖，用于可恢复签名）。

**已定的规则（2026-10-09 用户确认）：**
- 文件只增不改：链上已有同名但内容不同的文件，拒绝发布；只有 `index.html` 可以在最后替换，且只能单块（≤24000 字节）
- 不删除链上旧文件
- 临时私钥不导出；用 Electron `safeStorage` 加密存盘，只为崩溃后续传和退款
- 第一版只支持 BSC 和 X Layer，Base 不开放；不做铸造新电路

**合约接口出处：** TapeKit SPEC 附录 B.5、deweb.tapeoutexplorer.com 发布页、id.tapeout.link（见 memory `siteregistry-operator`）。

---

## 阶段总览

| 阶段 | 内容 | 产出 | 能否单独合并 |
|---|---|---|---|
| 1 | 纯模块：选择器、交易签名、发布计划、交易数据、预检查补充 | 5 个任务，全有单测 | 可以，不影响现有功能 |
| 2 | 临时操作员钱包存储 + 发布引擎（注入式，可测） | 状态机 + 单测 | 可以 |
| 3 | main.js IPC + 界面：选链、选电路、开通、上传进度、退款 | 能在真实应用里走通 | 可以（隐藏在本地预览面板里） |
| 4 | X Layer 实测 + 收尾 | live 测试脚本、文案、i18n | 发布前 |

每个阶段完成后停下来，让用户确认再开始下一阶段。本文只把阶段 1 写到逐步级别，阶段 2–4 开始前再细化。

---

## 阶段 1：纯模块

### Task 1：新增函数选择器和发布常量

**Files:**
- Modify: `src/main/config.js`（`SIG`、`SEL` 两张表，以及文件末尾的常量）
- Test: `test/address.test.mjs` 里已有「函数选择器与签名一致」，会自动覆盖新条目

**Step 1：先只在 `SIG` 里加签名（故意不加 `SEL`），让测试失败**

在 `SIG` 里加：

```js
  // 写接口（SPEC 附录 B.5）与开通容器（id.tapeout.link）
  putFile: 'putFile(address,string,string,bytes32,bytes)',
  appendChunk: 'appendChunk(address,string,uint256,bytes)',
  setOperator: 'setOperator(address,address,uint256)',
  canEdit: 'canEdit(address,address)',
  operatorOf: 'operatorOf(address)',
  operatorUntil: 'operatorUntil(address)',
  open: 'open(address,uint256)',
  openFee: 'FEE()',
  isDeployed: 'isDeployed(address,uint256)',
```

**Step 2：跑测试，确认失败**

Run: `node --test test/address.test.mjs`
Expected: FAIL，「函数选择器与签名一致」报 `putFile(...)` 的值是 `undefined`

**Step 3：在 `SEL` 里补上对应的值，并在文件末尾加常量**

```js
  putFile: '0xfab2ed82',
  appendChunk: '0xe2b51347',
  setOperator: '0xc88cb026',
  canEdit: '0xbcfe519c',
  operatorOf: '0x636f35d3',
  operatorUntil: '0xc85cf62b',
  open: '0x0a0e5c9d',
  openFee: '0xc57981b5',
  isDeployed: '0xf13906b8',
```

```js
// 发布到容器（和官方发布页一致）：操作员授权 6 小时；Gas 单价超过 0.1 gwei 就停，防止节点报出离谱的价格
export const OPERATOR_TTL = 21600;
export const MAX_GAS_PRICE = 100000000n;
// 单笔上传交易的 gas 上限：一块 24 KB 写成合约字节码约 500 万 gas，留足余量
export const MAX_UPLOAD_GAS = 15000000n;
// 第一版只开放这两条链（Base 上没有人实测过）
export const PUBLISH_NETWORKS = Object.freeze(['bnb', 'xlayer']);
```

**Step 4：跑测试，确认通过**

Run: `node --test test/address.test.mjs`
Expected: PASS

**Step 5：提交**

```bash
git add src/main/config.js
git commit -m "Add SiteRegistry write and container opener selectors"
```

---

### Task 2：交易签名模块 `eth-tx.js`（RLP + EIP-155 legacy 签名）

用 legacy 交易（type 0）：BSC 和 X Layer 都支持，官方发布页也是用 `gasPrice`。下面的代码在写计划时已经用 EIP-155 官方向量跑过，sighash 和 raw 都一致。

**Files:**
- Modify: `package.json`（dependencies 加 `"@noble/secp256k1": "3.2.0"`）
- Create: `src/main/eth-tx.js`
- Test: `test/eth-tx.test.mjs`

**Step 1：安装依赖（固定版本）**

Run: `npm install --save-exact @noble/secp256k1@3.2.0`
Expected: `package.json` 里出现 `"@noble/secp256k1": "3.2.0"`，`package-lock.json` 更新

**Step 2：写失败的测试 `test/eth-tx.test.mjs`**

```js
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
```

**Step 3：跑测试，确认失败**

Run: `node --test test/eth-tx.test.mjs`
Expected: FAIL，`Cannot find module '../src/main/eth-tx.js'`

**Step 4：实现 `src/main/eth-tx.js`**

```js
// 临时操作员签交易：RLP 编码 + EIP-155 legacy 签名。不依赖 Electron。
// 只签 legacy（type 0）交易：BSC 和 X Layer 都支持，和官方发布页一致。
// 签名用 @noble/secp256k1（零依赖，可恢复签名）；哈希用项目自带的 keccak。

import * as secp from '@noble/secp256k1';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { keccak256 } from './keccak.js';
import { hexToBytes, bytesToHex } from './abi.js';

// 同步签名要的哈希函数，用 Node 自带的实现
secp.hashes.sha256 = (m) => new Uint8Array(createHash('sha256').update(m).digest());
secp.hashes.hmacSha256 = (k, m) => new Uint8Array(createHmac('sha256', k).update(m).digest());

const EMPTY = new Uint8Array(0);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

/** 非负整数 → 最短大端字节（0 是空串） */
function intBytes(n) {
  const v = BigInt(n);
  if (v < 0n) throw new Error('eth-tx: negative integer');
  if (v === 0n) return EMPTY;
  const h = v.toString(16);
  return hexToBytes(h.length % 2 ? '0' + h : h);
}

function lenPrefix(len, short) {
  if (len < 56) return Uint8Array.of(short + len);
  const l = intBytes(len);
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
  const chainId = BigInt(tx.chainId);
  if (chainId <= 0n) throw new Error('eth-tx: bad chainId');
  const base = [intBytes(tx.nonce), intBytes(tx.gasPrice), intBytes(tx.gas), hexToBytes(tx.to), intBytes(tx.value ?? 0), hexToBytes(tx.data || '0x')];
  const sighash = keccak256(rlp([...base, intBytes(chainId), EMPTY, EMPTY]));
  // recovered 格式：第 0 字节是恢复位，后面是 r(32) s(32)；默认 lowS，和以太坊一致
  const sig = secp.sign(sighash, sk, { prehash: false, format: 'recovered' });
  const v = chainId * 2n + 35n + BigInt(sig[0]);
  const r = BigInt(bytesToHex(sig.subarray(1, 33)));
  const s = BigInt(bytesToHex(sig.subarray(33, 65)));
  const raw = rlp([...base, intBytes(v), intBytes(r), intBytes(s)]);
  return { sighash: bytesToHex(sighash), raw: bytesToHex(raw), hash: bytesToHex(keccak256(raw)) };
}
```

**Step 5：跑测试，确认通过**

Run: `node --test test/eth-tx.test.mjs`
Expected: PASS（5 个测试）

**Step 6：跑全部测试，再提交**

Run: `npm test`
Expected: fail 0

```bash
git add package.json package-lock.json src/main/eth-tx.js test/eth-tx.test.mjs
git commit -m "Add RLP and EIP-155 transaction signing for the upload operator"
```

---

### Task 3：发布计划 `publish-plan.js`（对比本地和链上，决定每个文件怎么传）

规则（和官方 `tapekit-publish-plan.js` 一致）：

| 链上状态 | 本地 | 动作 |
|---|---|---|
| 没有这个文件 | — | `create`：从第 0 块传起 |
| sha256 和 contentType 一致，块数相同 | — | `reuse`：不传 |
| sha256 和 contentType 一致，块数较少 | — | `append`：从链上块数接着传（断点续传） |
| 内容不同，是 `index.html`，本地 ≤ 24000 字节 | — | `replace`：最后用一笔 putFile 整个替换 |
| 内容不同，是 `index.html`，本地 > 24000 字节 | — | 冲突：首页太大，无法替换 |
| 内容不同，其他文件 | — | 冲突：拒绝覆盖，提示改文件名 |
| 一致但链上 size / 块数对不上 | — | 冲突：链上分块异常 |

冲突不抛异常，全部收集起来返回，界面一次列完。`index.html` 永远排在最后，其余按路径排序。contentType 用 `tape-protocol.js` 里按扩展名判断的结果，保证和读取时一致。

**Files:**
- Modify: `src/main/tape-protocol.js:15`（`function guessType` 改成 `export function guessType`）
- Create: `src/main/publish-plan.js`
- Test: `test/publish-plan.test.mjs`

**Step 1：写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planPublish, chunkOf, stepsOf, CHUNK_BYTES } from '../src/main/publish-plan.js';

const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
const file = (path, size, fill = 1) => { const bytes = new Uint8Array(size).fill(fill); return { path, bytes, sha256: sha(bytes) }; };
// 链上已经传了 count 块的同一个文件
const onChain = (f, count, contentType) => ({
  size: Math.min(count * CHUNK_BYTES, f.bytes.length), contentType, sha256: f.sha256, updatedAt: 1, chunkCount: count,
});
const row = (p, path) => p.rows.find((r) => r.path === path);

test('新文件全部 create，index.html 排最后，交易数按 24000 字节一块', () => {
  const files = [file('index.html', 100), file('b.js', 50000), file('a.css', 10)];
  const p = planPublish(files, [null, null, null]);
  assert.deepEqual(p.rows.map((r) => r.path), ['a.css', 'b.js', 'index.html']);
  assert.deepEqual(p.rows.map((r) => r.action), ['create', 'create', 'create']);
  assert.equal(row(p, 'b.js').remaining, 3);
  assert.equal(p.transactions, 5);
  assert.equal(row(p, 'a.css').contentType, 'text/css; charset=utf-8');
  assert.deepEqual(p.conflicts, []);
});

test('内容相同的复用，传了一半的接着传', () => {
  const big = file('big.png', 60000);
  const same = file('a.js', 10);
  const p = planPublish([big, same], [onChain(big, 1, 'image/png'), onChain(same, 1, 'text/javascript; charset=utf-8')]);
  assert.equal(row(p, 'a.js').action, 'reuse');
  assert.equal(row(p, 'big.png').action, 'append');
  assert.equal(row(p, 'big.png').from, 1);
  assert.equal(row(p, 'big.png').remaining, 2);
  assert.equal(p.transactions, 2);
  assert.equal(p.reused, 1);
  assert.equal(p.uploadBytes, 60000 - CHUNK_BYTES);
});

test('首页内容变了：小于一块就最后替换，太大就算冲突', () => {
  const oldIndex = file('index.html', 100, 1);
  const small = file('index.html', 100, 2);
  const p = planPublish([small], [onChain(oldIndex, 1, 'text/html; charset=utf-8')]);
  assert.equal(row(p, 'index.html').action, 'replace');
  assert.equal(row(p, 'index.html').remaining, 1);
  const big = file('index.html', CHUNK_BYTES + 1, 2);
  const q = planPublish([big], [onChain(oldIndex, 1, 'text/html; charset=utf-8')]);
  assert.equal(q.conflicts[0].path, 'index.html');
  assert.equal(q.conflicts[0].reason, 'index-too-big');
});

test('其他文件内容变了是冲突，contentType 不同也算变了，链上分块异常也是冲突', () => {
  const a = file('a.js', 10, 1);
  const changed = file('a.js', 10, 2);
  const b = file('b.css', 10);
  const c = file('c.png', 30000);
  const bad = { ...onChain(c, 1, 'image/png'), size: 5 };
  const p = planPublish([changed, b, c], [onChain(a, 1, 'text/javascript; charset=utf-8'), onChain(b, 1, 'text/plain'), bad]);
  assert.deepEqual(p.conflicts.map((x) => [x.path, x.reason]), [['a.js', 'changed'], ['b.css', 'changed'], ['c.png', 'corrupt']]);
});

test('stepsOf：按顺序列出每一笔交易，第 0 块用 putFile', () => {
  const big = file('big.png', 60000);
  const p = planPublish([big, file('index.html', 10)], [onChain(big, 1, 'image/png'), null]);
  assert.deepEqual(stepsOf(p).map((s) => [s.path, s.index]), [['big.png', 1], ['big.png', 2], ['index.html', 0]]);
  assert.equal(chunkOf(big.bytes, 2).length, 60000 - 2 * CHUNK_BYTES);
});

test('空文件也要一笔 putFile', () => {
  const p = planPublish([file('empty.txt', 0)], [null]);
  assert.equal(row(p, 'empty.txt').remaining, 1);
});
```

**Step 2：跑测试，确认失败**

Run: `node --test test/publish-plan.test.mjs`
Expected: FAIL，`Cannot find module '../src/main/publish-plan.js'`

**Step 3：把 `tape-protocol.js` 的 `guessType` 导出**

`src/main/tape-protocol.js:15` 的 `function guessType(path) {` 改成 `export function guessType(path) {`。

**Step 4：实现 `src/main/publish-plan.js`**

```js
// 发布计划：对比本地文件和链上文件信息，决定每个文件怎么传。纯函数，不依赖 Electron。
//
// 规则和官方发布页一致：链上文件只增不改。内容相同的复用，传了一半的接着传；
// 内容不同的只有 index.html 可以在最后整个替换（只能单块），其他文件算冲突，要改文件名。
// index.html 永远最后传：传到一半时，旧首页和它引用的旧文件都还在，网站不会坏。

import { guessType } from './tape-protocol.js';

export const CHUNK_BYTES = 24000;
const INDEX = 'index.html';

/** 文件要几块；空文件也要一笔 putFile */
export const chunksOf = (size) => Math.max(1, Math.ceil(size / CHUNK_BYTES));
/** 第 i 块的字节 */
export const chunkOf = (bytes, i) => bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);

/**
 * files = [{path, bytes, sha256}]；infos 和 files 一一对应，是 chain.fileInfo 的结果（不存在为 null）。
 * 返回 {rows, conflicts, transactions, uploadBytes, reused}：
 *   rows      [{path, bytes, sha256, contentType, chunks, action, from, remaining, uploadBytes}]
 *             action 是 create / append / replace / reuse；from 是从第几块开始传
 *   conflicts [{path, reason}]，reason 是 changed / index-too-big / corrupt；有冲突就不能发布
 */
export function planPublish(files, infos) {
  const rows = [];
  const conflicts = [];
  files.forEach((f, i) => {
    const info = infos[i];
    const contentType = guessType(f.path);
    const chunks = chunksOf(f.bytes.length);
    const base = { path: f.path, bytes: f.bytes, sha256: f.sha256, contentType, chunks };
    if (!info) {
      rows.push({ ...base, action: 'create', from: 0, remaining: chunks, uploadBytes: f.bytes.length });
      return;
    }
    const same = String(info.sha256).toLowerCase() === String(f.sha256).toLowerCase() && info.contentType === contentType;
    if (!same) {
      if (f.path !== INDEX) conflicts.push({ path: f.path, reason: 'changed' });
      else if (f.bytes.length > CHUNK_BYTES) conflicts.push({ path: f.path, reason: 'index-too-big' });
      else rows.push({ ...base, action: 'replace', from: 0, remaining: 1, uploadBytes: f.bytes.length });
      return;
    }
    const count = info.chunkCount;
    if (count > chunks || info.size !== Math.min(count * CHUNK_BYTES, f.bytes.length)) {
      conflicts.push({ path: f.path, reason: 'corrupt' });
      return;
    }
    if (count === chunks) rows.push({ ...base, action: 'reuse', from: count, remaining: 0, uploadBytes: 0 });
    else rows.push({ ...base, action: 'append', from: count, remaining: chunks - count, uploadBytes: f.bytes.length - info.size });
  });
  const order = (a, b) => (a.path === INDEX) - (b.path === INDEX) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  rows.sort(order);
  conflicts.sort(order);
  return {
    rows,
    conflicts,
    transactions: rows.reduce((n, r) => n + r.remaining, 0),
    uploadBytes: rows.reduce((n, r) => n + r.uploadBytes, 0),
    reused: rows.filter((r) => r.action === 'reuse').length,
  };
}

/** 按顺序列出每一笔上传：[{path, index, row}]；index 为 0 的用 putFile，其余用 appendChunk */
export function stepsOf(plan) {
  const out = [];
  for (const row of plan.rows) for (let i = row.from; i < row.from + row.remaining; i++) out.push({ path: row.path, index: i, row });
  return out;
}
```

**Step 5：跑测试，确认通过**

Run: `node --test test/publish-plan.test.mjs test/tape-protocol.test.mjs`
Expected: PASS

**Step 6：提交**

```bash
git add src/main/publish-plan.js src/main/tape-protocol.js test/publish-plan.test.mjs
git commit -m "Add publish plan that compares local files with the container"
```

---

### Task 4：交易数据 `publish-tx.js`（拼 calldata + 操作员交易白名单）

持有人的交易（开通、授权、撤销、充值）和操作员的交易（上传、退款）都在这里拼好。操作员签名前一律过 `assertOperatorTx`：只能调 registry 的 putFile / appendChunk、容器必须是本次的容器、不带原生币、gas 和单价不超上限；退款只能转给持有人、不带 data。私钥在主进程里，这一层白名单是防止 bug 或被篡改的参数把余额花到别处。

**Files:**
- Create: `src/main/publish-tx.js`
- Test: `test/publish-tx.test.mjs`

**Step 1：写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadTx, openTx, grantTx, revokeTx, fundTx, refundTx, assertOperatorTx } from '../src/main/publish-tx.js';
import { BSC, SEL, OPERATOR_TTL, MAX_GAS_PRICE } from '../src/main/config.js';
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
```

**Step 2：跑测试，确认失败**

Run: `node --test test/publish-tx.test.mjs`
Expected: FAIL，`Cannot find module '../src/main/publish-tx.js'`

**Step 3：实现 `src/main/publish-tx.js`**

```js
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
```

**Step 4：跑测试，确认通过**

Run: `node --test test/publish-tx.test.mjs`
Expected: PASS（4 个测试）

**Step 5：提交**

```bash
git add src/main/publish-tx.js test/publish-tx.test.mjs
git commit -m "Add publish transactions and operator allowlist"
```

---

### Task 5：预检查补充「首页超过一块就不能再更新」

「文件只增不改」带来两个后果：`index.html` 超过 24000 字节时，以后只能首发、不能替换；资源文件改了内容必须换文件名。后者要先读链上信息才知道，在发布计划（Task 3）里作为冲突报告；前者在本地就能判断，放进预检查。

**Files:**
- Modify: `src/main/precheck.js`（「1. 能不能上链」那一段，`index` 判断之后）
- Modify: `src/i18n/en.json`（加一条翻译）
- Test: `test/precheck.test.mjs`

**Step 1：写失败的测试，追加到 `test/precheck.test.mjs` 末尾**

```js
test('首页超过一块：能首发，但以后不能替换', async () => {
  const big = folder({ 'index.html': '<title>x</title>' + 'a'.repeat(24000) });
  assert.match(texts(await precheck(big), 'warn'), /24000/);
  const small = folder({ 'index.html': '<title>x</title>' });
  assert.doesNotMatch(texts(await precheck(small), 'warn'), /24000/);
});
```

**Step 2：跑测试，确认失败**

Run: `node --test test/precheck.test.mjs`
Expected: FAIL，「首页超过一块」那个测试的 `assert.match` 失败

**Step 3：在 `src/main/precheck.js` 的 `if (!index) add('error', …)` 下一行加**

```js
  // 链上文件只增不改，只有单块的首页能在以后替换（publish-plan.js）
  if (index && index.size > CHUNK_SIZE) add('warn', tr('index.html 有 {size}，超过 24000 字节（一块）。第一次能发布，但以后不能再替换首页；建议把脚本和样式拆出去', { size: kb(index.size) }));
```

**Step 4：在 `src/i18n/en.json` 里加对应条目**

```json
 "index.html 有 {size}，超过 24000 字节（一块）。第一次能发布，但以后不能再替换首页；建议把脚本和样式拆出去": "index.html is {size}, over 24000 bytes (one chunk). It can be published once, but the home page can't be replaced later; move scripts and styles into separate files",
```

**Step 5：跑测试，确认通过**

Run: `node --test test/precheck.test.mjs test/i18n.test.mjs`
Expected: PASS

**Step 6：跑全部测试，再提交**

Run: `npm test`
Expected: fail 0

```bash
git add src/main/precheck.js src/i18n/en.json test/precheck.test.mjs
git commit -m "Warn in precheck when index.html can't be replaced later"
```

**阶段 1 结束：停下来，让用户确认，再细化阶段 2。**

---

## 阶段 2：临时钱包存储 + 发布引擎（开始前再细化成逐步任务）

**Task 6：`operator-store.js`**：临时钱包的持久化。
- 每个（链, 容器, 持有人）一个记录：`{chainId, container, owner, address, key, pending, createdAt}`，存到 `userData/publish/<chainId>-<container>.json`。
- `key` 用注入的 `encrypt` / `decrypt` 处理，生产环境接 Electron `safeStorage`，测试用假实现。`safeStorage.isEncryptionAvailable()` 为 false 时拒绝创建临时钱包，提示改用「每块在钱包里确认」，或者先不发布。
- `pending` 保存「已签名、还没确认」的交易 `{raw, hash, kind, path, index}`，要在广播之前写盘。重试时广播的永远是同一笔，不会重复花钱。
- 退款成功、余额为 0 之后才删除记录。

**Task 7：`publisher.js`**：发布引擎。依赖全部注入：`rpc`、`chain`、`ownerSend(tx)`（持有人发交易，生产环境走 bridge）、`store`、`now`。这样整个流程可以用假链做单测。状态机：

1. `inspect`：读电路信息（`circuitInfos`）和全部文件的 `fileInfos`，再调 `planPublish`。有冲突就停，把冲突列表交给界面显示。
2. `open`（仅未开通时）：读 `opener.FEE()` → 持有人发 `openTx` → 等回执 → 核对 `isOpened`、`isDeployed`、`accountOf`。
3. `grant`：`canEdit(container, op)` 为 false，或者 `operatorUntil` 离到期不到 5 分钟时，持有人发 `grantTx`。
4. `fund`：先给第一笔上传交易 `eth_estimateGas`，估算总量 = 每块 gas × 交易笔数 × gasPrice × 1.2，减去临时钱包现有余额，差额由持有人发 `fundTx`。gasPrice 超过 `MAX_GAS_PRICE` 就停。
5. `upload`：对每个 `stepsOf(plan)` 依次执行：
   - nonce 要满足 `latest == pending`，否则先处理 pending；
   - 估算 gas，乘 1.25 作为上限；
   - 过 `assertOperatorTx`，然后 `signLegacy`；
   - 写盘 pending，再 `eth_sendRawTransaction`（「already known」算成功）；
   - 等回执，回执 status 为 0 就停；
   - 再读一次 `fileInfo`，确认块数前进了。

   余额不够时回到 `fund`。
6. `verify`：用 `chain.readVerified` 逐个回读，核对 sha256。X Layer 要等 `safe` 区块覆盖到上传完成的那个区块。
7. `refund`：余额减去 21000 × gasPrice 后转回持有人，然后删除记录。授权不主动撤销，6 小时后自然过期，省用户一次签名。界面上提供「立即撤销授权」按钮。

操作员签名只暴露一个入口 `signOperatorTx(op, net, tx, opts)`：内部先把字段复制成一个新对象并冻结，再过 `assertOperatorTx`，最后用这个对象 `signLegacy`。不要把「检查」和「签名」分开导出给 IPC 或别的模块用，否则调用方可能在两步之间改掉 tx，绕过白名单（Task 4 审查意见）。

暂停和恢复：每一步都从链上状态重新算，不信任本地进度。重新 `inspect` 一次，就自然接上断点。

## 阶段 3：接入应用（开始前再细化）

**Task 8：IPC（`main.js`）**
- `publishTargets(netKey)`：用 `sites.scanWalletOn` 加 `chain.circuitInfos`，列出钱包在这条链上的电路 `{label, tokenId, cpu, container, opened, hasIndex}`。结果按（链, 钱包）缓存。
- `publishInspect({root, target})` / `publishStart` / `publishPause` / `publishRefund` / `publishRevoke`。进度通过 `send('publish', state)` 推给界面。
- 持有人交易沿用打赏的方式：先用 `dialog.showMessageBox` 说明要签什么、花多少钱，再 `bridge.request('eth_sendTransaction', …)`。数值转成 0x 十六进制。
- 钱包不在目标链上时，先请钱包切换（复用 `switchChain`）。
- 启动时扫描 `userData/publish/`，发现残留记录就提示「继续上传」或「退回余额」。

**Task 9：界面（`ui.js` / `index.html`）**：在本地预览的「发布预检查」面板下面加「发布到容器」：
- 选链（BSC / X Layer）→ 选电路（显示是否开通、开通费）→ 显示发布计划（复用、要传的交易笔数、字节数、预估花费、冲突列表）→ 开始。
- 进度条显示第几块、当前文件，以及持有人签名的步骤提示。
- 完成后显示「打开网站」，打开 `tape://<编号>/`，并显示退款结果。
- 所有新文案都进 `en.json`。

## 阶段 4：实测与收尾

- **Task 10**：`test/live.mjs` 增加只读检查：两条链上的 `FEE()`、`canEdit`、`operatorUntil` 能正常调用，选择器对得上。
- **Task 11**：用户在 X Layer 上用一个便宜的电路实测一遍完整流程：开通、授权、充值、上传几个文件（包括一个多块文件）、中途杀掉应用再续传、替换首页、退款。顺便确认 `open` 是否只允许持有人调用。
- **Task 12**：README 和官网补充发布说明，然后发版。

## 已知风险

- 系统钥匙串被重置时，`safeStorage` 解不开，临时钱包里的余额就找不回来了。所以充值只按估算值乘 1.2，不预充大额。
- 公共节点限速：广播要依次尝试多个节点，等回执之间加间隔。
- 合约是可升级的（UUPS），以后接口可能变。每次发布前做一次 `eth_call` 模拟，发现问题就停下。









