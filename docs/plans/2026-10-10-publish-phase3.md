# 发布到容器 · 阶段 3：接入应用

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 在本地预览里加「发布到容器」入口，用户能在应用里选链、选电路、看计划和花费、开始发布、看进度、退款，最后打开网站。

**Architecture:** 业务逻辑仍然放在不依赖 Electron、可注入、有单测的模块里（`owner-send.js`、`publish-service.js`）；`main.js` 只做薄接线（safeStorage、bridge、IPC、dialog）；界面是一个全屏页面（和设置页一样用 overlay），从本地预览面板的按钮打开。

**必须遵守：** `docs/plans/2026-10-09-publish-phase2.md` 末尾的「阶段 3 必须遵守的契约」8 条。

**已定的交互（可在审查时调整）：**
- 发布页的「开始发布」就是用户对整份计划和预估花费的同意；之后每一笔持有人交易只在钱包里确认，应用用顶部提示说明这一步要签什么（开通容器并付开通费 / 授权临时钱包 6 小时 / 充值 gas）。不再额外弹原生对话框。
- 放弃零头（discardDust）和单独退款都要先弹原生对话框确认。

**通用约定：** 中文注释；新增界面文字全部进 `src/i18n/en.json`（`test/i18n.test.mjs` 会检查，要把新文件加进它扫描的列表）；纯模块按 TDD；`main.js` / `ui.js` 没有单测，靠 i18n 测试和手动启动检查。

---

## Task 11：桥接超时和用户拒绝分开（`bridge-server.js`）

现在桥接请求 5 分钟超时也用 4001 拒绝，和用户点「拒绝」分不开。改成超时 reject `{ code: 4001, message: '钱包请求超时', timeout: true }`（保留 4001 以免影响现有调用方），测试覆盖超时带 `timeout: true`、用户拒绝不带、页面关闭是 4900。

提交信息：`Mark wallet bridge timeouts`

## Task 12：持有人发交易（`owner-send.js`）

`createOwnerSend({ bridge, net, origin, onStep })` → `ownerSend(tx, kind)`，实现契约第 1 条：
- `bridge.state.ready` 为假 → 抛 `WALLET_NOT_CONNECTED`「请先连接钱包」。
- `bridge.state.accounts[0]` 不等于 `tx.from`（不分大小写）→ 抛 `WALLET_ACCOUNT`「钱包当前账户不是这个电路的持有人」。
- `bridge.state.chainId` 不等于 `net.chainIdHex` → 先 `bridge.request('wallet_switchEthereumChain', [{ chainId }], origin)`，再核对一次，仍不对抛 `WALLET_CHAIN`。
- 发之前调 `onStep({ kind, value })`，界面据此提示这一步要签什么。`kind` 是 `'open' | 'grant' | 'fund'`，由 publisher 的 `ownerTx(ctx, kind, tx)` 作为第二个参数传给 `ownerSend`（publisher.js:349 改成 `ownerSend(tx, kind)`，publisher 测试的假 ownerSend 照样能用）。
- bigint 字段转 0x 十六进制，`bridge.request('eth_sendTransaction', [tx], origin)`。
- 返回值不是 0x + 64 位十六进制 → 原样返回（publisher 已处理 BAD_WALLET_HASH）。
- 用户拒绝（4001 且没有 `timeout`）→ 抛 `USER_REJECTED`「你在钱包里拒绝了这笔交易」。
- 超时或 4900 → 抛 `WALLET_LOST`「钱包没有回应，交易可能已经发出；稍后继续时会先检查」。publisher 下次 run 靠 nonce 检查兜底。

在 `publish-errors.js` 加这几个码。测试 `test/owner-send.test.mjs` 用假 bridge 覆盖以上每一条。

提交信息：`Add the holder transaction sender for publishing`

## Task 13：列出钱包在一条链上的全部电路（`sites.js`）

现有的 `scanWalletOn` 只返回有 `index.html` 的电路，发布要的是全部电路，包括没开通的。

新增 `sites.circuitsOf(netKey, wallet, onProgress)`：
- 复用 `scanWalletOn` 前半段（cpuList → holdings → ownedIds，把这段抽成内部函数，两处共用）。
- 再用 `circuitInfos` 读出每个电路的 `{ owner, container, opened }`；已开通的再批量读 `index.html` 的 fileInfo，判断有没有首页。
- 返回 `{ circuits: [{ tokenId, cpu, circuits, label, container, opened, hasIndex }], skipped }`。`label` 用 `siteLabel(tokenId, cpu, net.area)`；按 label 排序。
- 只允许 `PUBLISH_NETWORKS` 里的链，其他抛 `CHAIN_UNSUPPORTED`。

测试放在 `test/sites-multichain.test.mjs`，沿用里面的假链：没开通、开通没首页、开通有首页三种电路都列出来，字段正确；`scanWalletOn` 的原有结果不变。

提交信息：`List every circuit a wallet holds for publishing`

## Task 14：发布服务 `publish-service.js`（主进程里的编排，不依赖 Electron）

`createPublishService({ chains, rpcs, sites, localSites, precheck, bridge, secure, dir, networks, now, sleep, onEvent })`，`main.js` 只负责把真实依赖传进来。对外的方法就是 IPC 能调用的全部（契约第 3 条）：

| 方法 | 说明 |
|---|---|
| `available()` | `secure.available()` 为假，或者 `secure.backend === 'basic_text'` → `{ ok: false, reason }`。界面据此显示「这台电脑无法安全保存临时钱包，暂时不能发布」 |
| `targets({ netKey })` | 当前钱包账户在这条链上的电路：`sites.circuitsOf(netKey, account)`。要求钱包已连接 |
| `inspect({ root, netKey, tokenId, cpu })` | 在主进程里构造 target，`readFiles` 和 `precheck` 都用 `localSites` 读 `root`（root 必须是 `localSites.roots()` 里登记过的文件夹）。结果存进内存里的 `sessions`（id → inspected，同时只保留最近 5 个），返回脱敏摘要 |
| `run({ id })` | 取出 session 里的原件调用 `publisher.run`，进度通过 `onEvent('publish', { id, ...progress })` 推送；同一时间只能有一个 run（服务级别），第二个抛 `BUSY` |
| `pause({ id })` | 设置这次 run 的 abort 信号 |
| `refund({ netKey, container })` / `discardDust({ netKey, container })` | 转给对应链的 publisher |
| `leftovers()` | 每条发布链 `store.list()` + `broken()`：有余额（在 latest 读）或有 pending / ownerPending 的记录列出来；余额为 0、没有在途交易的空记录直接 `store.remove`；坏文件单列 |

要点：
- 每条链一个 `operator-store`（目录 `dir/<netKey>`），用 `secure.encrypt` / `secure.decrypt`；每条链一个 publisher，懒创建，整个服务只有这一组（契约第 6 条）。
- `ownerSend` 用 Task 12 的 `createOwnerSend`，`onStep` 转成 `onEvent('publish', { id, stage: 'wallet', kind })`。
- 摘要只含可序列化的字段：bigint 一律转十进制字符串；`files` 只给 `{ path, size, action }`，不给 bytes；不含 store 记录里的任何东西（契约第 2 条）。
- 错误原样抛出（带 code），由 `main.js` 的 IPC 层转成 `{ code, message }`。

测试 `test/publish-service.test.mjs`：假的 secure / bridge / sites / localSites，加上阶段 2 测试里的有状态假链（抽到 `test/helpers/fake-chain.mjs` 供两边共用）。覆盖：
- secure 不可用或是 basic_text 时拒绝；
- inspect 只接受登记过的 root，摘要里没有 bytes 和 bigint；
- run 按 id 取原件，渲染进程传任何别的东西都不认；
- 第二个 run 被拒；pause 生效；进度事件带 id；
- leftovers 清理空记录、列出有余额和有在途交易的、单列坏文件。

提交信息：`Add the publish service that main wires into IPC`

## Task 15：接线 `main.js`

- `secure`：`safeStorage.isEncryptionAvailable()`、`safeStorage.getSelectedStorageBackend?.()`（只有 Linux 有）、`encryptString` / `decryptString`。
- `createPublishService(...)`，目录 `userData/publish`，`onEvent` 用现有的 `send`。
- IPC：`ui('publishAvailable')`、`ui('publishTargets', netKey)`、`ui('publishInspect', args)`、`ui('publishRun', id)`、`ui('publishPause', id)`、`ui('publishRefund', args)`、`ui('publishDiscard', args)`、`ui('publishLeftovers')`。
  - 错误统一转成 `{ error: { code, message } }` 返回（不 throw），message 用 `tr` 翻译。
  - `publishRefund` 和 `publishDiscard` 先用 `dialog.showMessageBox` 确认，讲清楚退给谁、多少；放弃零头要写明这笔钱拿不回来。
- 启动时（窗口建好之后）调一次 `leftovers()`，有残留就 `notify` 一条提示，并在发布页里列出来。
- 把 `publish-service.js`、`owner-send.js` 和 `publisher.js` 加进 `test/i18n.test.mjs` 扫描的文件列表，所有中文提示进 `en.json`。

提交信息：`Wire publishing into the main process`

## Task 16：发布页界面（`index.html` / `ui.js` / `ui.css`）

入口：本地预览面板 `renderLocal` 末尾加按钮「发布到容器…」，打开全屏发布页（overlay，和设置页同一套）。

发布页从上到下：
1. **选链**：BNB Chain / X Layer 两个按钮；钱包没连接时提示先连接；`publishAvailable` 不通过时整页只显示原因。
2. **选电路**：`publishTargets` 的列表，每行显示编号、是否开通（没开通时显示开通费，开通费在 inspect 之后才知道，先写「需要开通容器」）、有没有首页。没有电路时提示去 TapeOut 官网铸造。
3. **发布计划**：选好电路后自动 `publishInspect`，显示：
   - 新上传 / 续传 / 复用 / 替换首页各多少个文件，一共多少笔交易、多少字节；
   - 预估花费：开通费 + 上传 gas，用链的币种显示；
   - blocked：列出预检查错误；conflicts：列出冲突文件和原因（改文件名的建议）；
   - 首页超过一块时提示更新期间网站会暂时打不开。
4. **开始发布**：一个按钮，旁边写明「接下来钱包会请你确认 2 到 3 笔交易：开通容器（如果需要）、授权临时钱包 6 小时、充值上传用的 gas。剩下的 gas 发布完自动退回」。
5. **进度**：当前步骤（开通 / 授权 / 充值 / 上传 第几块 / 核验 / 退款），进度条按 `done/total`；`stage: 'wallet'` 时醒目提示「请在浏览器的钱包扩展里确认：…」；「暂停」按钮，旁边说明暂停会在当前这笔交易完成后生效。
6. **结果**：成功时显示上传了几笔、花了多少、退回多少，「打开网站」按钮打开 `tape://<编号>/`；`verified: false` 时写明「还没核验完（等安全区块超时），可以稍后重新打开网站检查」；失败时按错误码给出提示和按钮：LATER / PENDING_TIMEOUT / WALLET_LOST → 「继续发布」；STATE_CHANGED → 「重新检查」；USER_REJECTED → 「重新开始」；其他 → 显示原因，并始终提供「退款」。
7. **残留**：页面底部列出 `publishLeftovers`，每条可以「继续发布」（重新 inspect 同一个电路）或「退款」，零头的可以「放弃零头」。

所有文字进 `en.json`；样式沿用 `ui.css` 的变量和 `.check-list`、`button.link`。

提交信息：`Add the publish page`

## Task 17：手动走查

用 `npm start` 启动，在本地预览里打开发布页，不连钱包、连错链、选没开通的电路、预检查有错误、有冲突几种情况各看一遍，截图记录；不发真实交易（真实交易放到阶段 4 在 X Layer 上做）。修掉走查发现的问题。

## 阶段 3 结束

整体审一遍，停下来等用户确认，再进入阶段 4（X Layer 实测）。

