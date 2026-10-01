# TapeBrowser

浏览 TapeKit 电路容器里 DeWEB 网站的桌面浏览器（Electron）。第一版只做了 macOS，Windows / Linux 的打包配置已经写好。

## 地址栏能输入什么

| 输入 | 效果 |
| --- | --- |
| `4454.0`、`4454-0`、`#4454@0`、`tape://4454-0`、`4454.0.tape` | 打开电路 #4454（处理器 0）的网站 |
| `12330`、`12330.tape`、`tape://12330` | 试所有切分（1.2330、12.330、123.30、1233.0），有 `index.html` 的都开一个标签 |
| `0x…` 钱包地址 | 扫描钱包持有的全部电路，容器已开通、有 `index.html` 的都开一个标签 |
| `https://…`、`example.com` | 普通网页照常打开 |

网站地址的格式是 `tape://<ID>-<处理器>/路径`。主机名用连字符而不用点，因为 Chromium 会把 `4454.0` 这种全数字主机名当成 IPv4 地址。

## 连接钱包

TapeBrowser 不导入私钥，也不用 WalletConnect，而是通过系统浏览器里的钱包扩展签名：

1. 网页调用 `eth_requestAccounts`（或点工具栏的「连接钱包」），TapeBrowser 在系统浏览器中打开本机桥接页面 `http://127.0.0.1:47654/?t=<口令>`。
2. 在桥接页面选好钱包扩展（MetaMask 等，支持 EIP-6963）并授权。
3. TapeBrowser 弹窗确认是否把地址给这个网站。签名和交易同样先由 TapeBrowser 弹窗显示是哪个网站发起的，再交给钱包扩展确认。钱包扩展那边看到的来源只会是 127.0.0.1。

只读请求（`eth_call` 等）在 BSC 上走内置的公共 RPC 池，不经过钱包。已授权的网站可以在设置里取消授权。要断开钱包，在设置页或菜单「钱包 → 断开钱包」操作；网站授权会保留，重新连接后不用再确认。OKX 等不支持 `wallet_revokePermissions` 的钱包，扩展里对 127.0.0.1 的授权需要在扩展里手动移除。

## 开发

需要 Node 22.12 或更高版本（见 `.nvmrc`）。

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

```bash
npm run live
```

```bash
npm run dist:mac
```

`npm run live` 是主网只读冒烟测试，需要联网。打包产物没有签名，第一次打开时 Gatekeeper 会拦截，需要右键选择「打开」。

## 代码结构

- `src/main/`：主进程。`tape-protocol.js` 负责从链上读取并校验文件，`sites.js` 负责枚举和钱包扫描，`bridge-server.js` 是钱包桥接服务，`provider-host.js` 处理网页的 EIP-1193 请求，`tabs.js` 管理标签页。
- `src/preload/`：`tab.cjs` 往网页注入 `window.ethereum`，`ui.cjs` 是外壳界面的 IPC。
- `src/ui/`：标签栏、地址栏和设置界面。
- `src/bridge/`：在系统浏览器里打开的钱包桥接页面。

## 安全说明

- 桥接服务只监听 127.0.0.1，页面和 WebSocket 都要求口令，同时校验 Host 和 Origin。口令保存在本机的 settings.json 里（文件权限 0600）。
- 网页的权限请求只放行全屏和剪贴板写入。
- 网页可以访问外部 http/https 地址，跟普通浏览器一样。
