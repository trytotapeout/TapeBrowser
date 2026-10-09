# 发布到容器 · 阶段 2：临时钱包 + 发布引擎

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 不接界面，先把「检查 → 开通 → 授权 → 充值 → 上传 → 核验 → 退款」整条流程做成可测试的后台逻辑。

**Architecture:** 分成 5 个模块，依赖全部注入，不依赖 Electron，全部用 node:test 加假链来测。持有人的交易通过注入的 `ownerSend(tx)` 发出，阶段 3 再接到桥接页。私钥的加解密通过注入的 `encrypt` / `decrypt` 完成，阶段 3 再接到 `safeStorage`。

**上一份计划：** `docs/plans/2026-10-09-publish-to-container.md`（阶段 1 已完成；「阶段 1 审查后给阶段 2 的约束」一节在本阶段必须遵守）。

**通用约定：**
- 中文注释，风格和 `src/main` 里现有模块一致。每个模块文件开头写一段说明。
- 金额、gas、gasPrice、nonce 一律用 bigint；交给钱包的交易在 `ownerSend` 里转成 0x 十六进制（阶段 3 做），本阶段的模块只传 bigint。
- 所有错误信息是给用户看的中文，直接写成字符串（这些模块不调用 `tr`，阶段 3 在 IPC 层翻译）。
- 每个任务都按 TDD：先写测试、确认失败、再实现、跑 `npm test`、提交。

---

## Task 6：链上只读补充（`chain.js`）

给发布流程补几个只读调用，加到 `createChain` 的返回值里：

| 函数 | 说明 |
|---|---|
| `openFee(block?)` | `opener.FEE()` → bigint |
| `isDeployed(circuits, tokenId, block?)` | `opener.isDeployed` → bool |
| `operatorState(container, operator, block?)` | 用 multicall 一次读 `canEdit(container, operator)` 和 `operatorUntil(container)` → `{ canEdit: bool, until: number }`（秒） |
| `gasPrice()` | `eth_gasPrice` → bigint |
| `nonceOf(address)` | 同时读 `latest` 和 `pending` 的 `eth_getTransactionCount` → `{ latest: bigint, pending: bigint }` |
| `estimateGas(tx)` | `eth_estimateGas`；`tx` 里的 bigint 字段转成 0x 十六进制后再发 → bigint |
| `receipt(hash)` | `eth_getTransactionReceipt` → `null`，或者 `{ status: 1 \| 0, blockNumber: bigint, gasUsed: bigint, effectiveGasPrice: bigint \| null }` |
| `sendRaw(raw)` | `eth_sendRawTransaction` → 交易哈希。节点报 `already known` / `known transaction` / `nonce too low` 时不抛出，返回 `{ known: true }`，由调用方去查回执 |
| `safeBlock()` | `eth_getBlockByNumber('safe', false)` 的区块号 → bigint；节点不支持 `safe` 时返回 `null` |

测试：新建 `test/chain-publish.test.mjs`，用一个假的 `rpc(method, params)`。按 `to` 和 calldata 的选择器返回编码好的结果，multicall 也照样解码。覆盖上表每个函数的正常返回，以及 `sendRaw` 的三种「已知」错误、`receipt` 返回 null、`safeBlock` 不支持这几种情况。

提交信息：`Add read helpers for publishing to chain.js`

---

## Task 7：临时钱包存储（`operator-store.js`）

`createOperatorStore({ dir, encrypt, decrypt, now = Date.now })`。每个（chainId, 容器）一个 JSON 文件：`<dir>/<chainId>-<container 小写>.json`，权限 0600，写入时先写 `.tmp` 再 rename（和 `settings.js` 一样）。

记录：`{ v: 1, chainId, container, owner, address, key, pending, lastNonce, createdAt }`
- `lastNonce` 是最后一笔已确认交易的 nonce（十进制字符串，没有时为 `null`）。只能往大改：`setLastNonce` 传进比现有值小的数时忽略。它是防止「公共节点落后、读到旧 nonce」的真正防线（Task 6 审查意见）。
- `key` 是 `encrypt(私钥 hex)` 的结果，用 base64 存；明文私钥不落盘、不出现在任何返回值或错误信息里。
- `pending` 是 `null`，或者 `{ raw, hash, kind: 'upload' | 'refund', path?, index?, nonce }`（nonce 存成十进制字符串）。

方法：
- `create({ chainId, container, owner })`：已有记录就返回已有的（`owner` 不同时抛出「这个容器已有另一个持有人的临时钱包」）；没有就用 `eth-tx.js` 的 `newKey()` 新建、写盘，返回 `{ address, ... }`（不含私钥）。`encrypt` 抛错时（钥匙串不可用）原样抛出，不写盘。
- `get(chainId, container)`：返回记录（不含私钥）或 `null`。
- `keyOf(chainId, container)`：返回解密后的私钥 `Uint8Array`，只给 Task 8 的签名入口用。解密失败时抛出「临时钱包无法解密（系统钥匙串可能已重置）」。
- `setPending(chainId, container, pending)` / `clearPending(chainId, container)` / `setLastNonce(chainId, container, nonce)`：每次都立即写盘。
- `remove(chainId, container)`：删文件。
- `list()`：列出全部记录（不含私钥），启动时找残留用。坏掉的 JSON 文件跳过，不抛出。

测试 `test/operator-store.test.mjs`：用临时目录（`mkdtempSync(join(tmpdir(), 'opstore-'))`，测试结束删掉）和假的 `encrypt` / `decrypt`（比如把字符串反转后加个前缀）。要覆盖：
- 新建、再次 `create` 返回同一个地址；
- 换个持有人会抛出；
- 文件里找不到明文私钥（用私钥 hex 在文件内容里搜）；
- `keyOf` 能正确解出私钥，并且 `addressOf(keyOf(...))` 等于记录里的地址；
- `encrypt` 抛错时不写盘；
- pending 写入后重建 store 还能读到；
- `remove` 之后 `get` 返回 null；
- `list` 跳过坏文件；
- 文件权限是 0600（只在非 Windows 上检查）。

提交信息：`Add encrypted store for the temporary upload operator`

---

## Task 8：操作员签名与广播（`operator.js`）

`createOperator({ store, chain, net, container, owner })`，只暴露下面这些方法。签名私钥只在 `send` 内部临时取出来用。

- `address`：临时钱包地址。
- `balance()`：`chain.nativeBalance(address)`。
- `async send(tx, { kind, path, index })`：唯一的签名入口。
  1. 如果还有 `pending`，先抛出「还有一笔交易在等确认」，调用方要先调 `settle()`。
  2. 用 `chain.nonceOf(address)` 读 nonce（Task 6 已改成取几个节点里的最大值）：
     - `pending > latest` → 抛出「临时钱包有未确认的交易」；
     - 记录里有 `lastNonce` 且 `latest <= lastNonce` → 抛出「节点还没同步到最新区块，请稍后再试」；
     - 否则用 `latest` 作为这笔交易的 nonce。
  3. 把交易复制成新对象 `{ to, value, data, gas, gasPrice, chainId: net.chainId, nonce }`，然后 `Object.freeze`。
  4. 对这个冻结的对象跑 `assertOperatorTx({ address, owner, container }, net, frozen, { refund: kind === 'refund' })`。
  5. 用 `signLegacy(store.keyOf(...), frozen)` 签名。
  6. 先 `store.setPending(...)`（`raw`、`hash`、`kind`、`path`、`index`、`nonce`）写盘，再 `chain.sendRaw(raw)`。
  7. 返回交易哈希。`sendRaw` 抛出网络错误时不清除 pending，原样抛出，重试由 `settle()` 负责。`sendRaw` 返回 `{ known: true, reason: 'pending' }` 算广播成功；返回 `reason: 'nonceUsed'` 时立刻调一次 `settle({ timeoutMs: 0 })`，由它判断是这笔交易已经上链，还是 nonce 被别的交易用掉了。
- `async settle({ timeoutMs = 120000, pollMs = 3000, sleep })`：处理 pending。
  - 没有 pending → 返回 `null`。
  - 查回执。有回执就先 `setLastNonce(pending.nonce)`，再清除 pending，返回 `{ hash, status, gasUsed, ... }`。status 为 0 时不在这里抛出，交给调用方判断（status 0 的交易也用掉了 nonce）。
  - 没回执就重新广播同一笔 `raw`。`sendRaw` 返回 `known`（不管哪种 reason）或者抛出任何错误，都继续轮询，不中止。然后按 `pollMs` 轮询，直到超时。
  - 超时抛出「交易还没确认，可以稍后继续」，pending 保留。
  - 回执没有、但 `nonceOf(address).latest > pending.nonce`：说明这个 nonce 已经被别的交易用掉了（理论上不会发生）。清除 pending，抛出「临时钱包的交易状态异常，请重新检查」。

测试 `test/operator.test.mjs`：用 Task 7 的真 store（临时目录）加一个假 `chain`，记录每次 `sendRaw` 收到的 raw，可以控制什么时候返回回执。要覆盖：
- 正常上传一笔；
- 白名单拒绝时不写 pending、不广播；
- 广播失败后 `settle` 重发的是同一笔 raw（哈希相同）；
- 有 pending 时 `send` 被拒；
- `pending > latest` 时被拒；
- 节点落后（`latest <= lastNonce`）时被拒；
- 确认后 `lastNonce` 前进，重建 store 后还在；
- `sendRaw` 返回 `nonceUsed`、但回执显示就是这笔交易时算成功；
- 回执 status 0 能正确返回；
- 超时后 pending 保留；
- 传进 `send` 的原始 tx 在签名期间被修改，也不影响签出来的交易（签名之后断言 raw 解出来的 data 等于原来的 data）。

`sleep` 要可以注入，测试里不真的等。

提交信息：`Add the operator signing and broadcast entry`

---

## Task 9：发布引擎 `publisher.js` 第一部分：检查和费用估算

`createPublisher({ chain, net, ownerSend, store, readFiles, precheck, now = Date.now, sleep })`。
- `readFiles()` 返回 `[{ path, bytes, sha256 }]`，阶段 3 用 `local-site` 实现。
- `precheck()` 返回 `{ items }`，阶段 3 用现有的 `precheck.js` 实现。

**`inspect({ target })`**：`target` 是 `{ circuits, tokenId, cpu, label }`。按顺序做：
1. `PUBLISH_NETWORKS` 里没有 `net.key` → 抛出「这条链暂时不支持发布」。
2. 跑 `precheck()`，有 `level === 'error'` 的项就停下，返回 `{ stage: 'blocked', errors }`。
3. 读电路状态：`chain.circuitInfos([{ circuits, tokenId }])` 得到 `{ exists, owner, container, opened }`；不存在就抛出。
4. 没开通 → `openFee = chain.openFee()`；已开通 → 读全部文件的 `chain.fileInfos`。没开通的容器里没有文件，`infos` 全部当 null。
5. `planPublish(files, infos)`；有冲突就返回 `{ stage: 'conflicts', conflicts }`。
6. 估算费用：
   - `gasPrice = chain.gasPrice()`，超过 `MAX_GAS_PRICE` 就抛出「当前 Gas 单价太高，请稍后再试」。
   - 每块的 gas：按「每块 gas = 21000 + 写入字节 × 16 + 写入字节 × 200 + 100000」估算一个上限。
   - 已开通、并且有要传的块时，再用 `chain.estimateGas` 估一下第一笔，取两者里较大的那个，乘 1.2。
   - 总花费 = 所有块的 gas × gasPrice。
7. 返回 `{ stage: 'ready', target, owner, container, opened, openFee, plan, steps: stepsOf(plan), gasPrice, uploadCost, totalCost }`。其中 `totalCost = uploadCost + (opened ? 0n : openFee)`。

测试 `test/publisher-inspect.test.mjs`：用假 chain，覆盖链不支持、预检查有错误、电路不存在、没开通（带开通费）、已开通有冲突、已开通正常（交易笔数和费用对得上）、gasPrice 超限这几种情况。

提交信息：`Add publisher inspection and cost estimate`

---

## Task 10：发布引擎第二部分：执行和恢复

在 `publisher.js` 里加 `run(inspected, { onProgress, signal })`。每一步都重新读链上状态，不信任上次的进度。`onProgress({ stage, done, total, path, index, hash })` 报告进度；`signal.aborted` 为 true 时在两笔交易之间停下，返回 `{ stage: 'paused' }`。

1. **开通**（只在 `!opened` 时）：
   - 持有人 `ownerSend(openTx(...))`，拿到 hash 后用 `chain.receipt` 轮询到确认。status 0 抛出「开通容器失败」。
   - 确认后核对 `isOpened`、`chain.isDeployed`、`accountOf` 都对得上，然后重新 `inspect`。
2. **临时钱包**：`store.create(...)` 拿到操作员地址，再 `createOperator(...)`。先 `operator.settle()` 处理上次留下的 pending。
3. **授权**：`chain.operatorState(container, op)`：`!canEdit`，或者 `until < now/1000 + 300` → 持有人 `ownerSend(grantTx(...))`，等确认，再读一次确认已经生效。
4. **充值**：
   - 需要的金额 = 剩余每块 gas 上限 × gasPrice × 1.2，再减去临时钱包现有余额。
   - 计划里有首页要替换时，要确保余额够传完首页的全部块，所以首页的块总是算进剩余金额里。
   - 金额大于 0 时，持有人 `ownerSend(fundTx(...))`，等确认。
5. **上传**：重新 `inspect` 得到最新的 `steps`，然后逐笔处理：
   - 先用 `chain.estimateGas` 估算，乘 1.25，再和 `MAX_UPLOAD_GAS` 取较小值；
   - `operator.send(uploadTx(...))`，然后 `operator.settle()`；
   - status 0 抛出「上传 {path} 第 {index} 块失败」。
   - 每 10 笔或者上传完一个文件后，用 `chain.fileInfo` 核对块数增加了。
   - 余额不够时（估算出的花费大于余额）回到第 4 步。
6. **核验**：
   - 对每个文件跑 `chain.readVerified(container, path, info)`。
   - X Layer（`net.key === 'xlayer'`）要先等 `chain.safeBlock()` 覆盖到最后一笔回执的区块。拿不到 safe 区块时跳过这一步，在结果里注明。
7. **退款**：
   - 余额减去 gas × gasPrice 后转回持有人。持有人是普通地址时 gas 用 21000；`eth_getCode` 不是 `0x` 时用 `estimateGas` 乘 1.25。
   - 可退金额 ≤ 0 时跳过退款，保留记录，返回里写上 `dust: true`。
   - 退款确认之后余额为 0 才 `store.remove`。
8. 返回 `{ stage: 'done', container, label, uploaded, reused, spent, refunded }`。

另外导出 `refund({ chainId, container })`，给「放弃发布、只退钱」用：先 `settle`，再执行退款，最后删除记录。

测试 `test/publisher-run.test.mjs`：用一个带状态的假链。它要真的记录 putFile / appendChunk 写进去的块：解码 calldata，把块写进内存里的「容器」；`fileInfo` 和 `readVerified` 都从内存返回；余额会按 gas 扣减。覆盖下面这些情况：
- 已开通的容器，从零开始发布 3 个文件（其中一个多块），全部完成；
- 没开通的容器：先开通，再发布；
- 中途 abort，再 `run` 一次接着传完，不重复上传已经确认的块；
- 上传中途广播失败，重启以后 `settle` 重发同一笔交易；
- 首页替换：链上已有旧首页；
- 余额不够时会再次充值；
- 回执 status 0 时停下并报错；
- 退款金额不够付手续费时保留记录；
- 授权快过期时会重新授权。

提交信息：`Add publisher run, resume and refund`

---

## 阶段 2 结束

最后整体审一遍，然后停下来，等用户确认后再细化阶段 3（IPC 和界面）。
