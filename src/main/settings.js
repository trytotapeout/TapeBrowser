// 本机设置：userData/settings.json。不依赖 Electron（路径由调用方传入）。
//   rpcs         每条链的自定义 RPC 节点 { bnb: [...], xlayer: [...], base: [...] }，空数组表示用内置节点
//                （旧版只有 BNB 的 rpcUrls，启动时迁移过来）
//   bridgePort   钱包桥接页面端口：固定下来，钱包扩展对 127.0.0.1:<端口> 的授权才能一直有效
//   bridgeToken  桥接页面口令：只有带口令的页面才能接入
//   permissions  已授权读取钱包地址的网站 { origin: 授权时间 }
//   signBaselines 每个网站上次同意签名时已加载的链上文件 { origin: { path: sha256 } }（page-audit.js 用）

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function createSettings(file) {
  let data = {};
  try { data = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
  if (!data.rpcs || typeof data.rpcs !== 'object' || Array.isArray(data.rpcs)) data.rpcs = {};
  if (Array.isArray(data.rpcUrls)) {
    if (data.rpcUrls.length && !data.rpcs.bnb) data.rpcs.bnb = data.rpcUrls;
    delete data.rpcUrls;
  }
  // 旧版的浏览器身份登录记录，已不再使用
  delete data.identity;
  if (!data.permissions || typeof data.permissions !== 'object') data.permissions = {};
  if (!data.signBaselines || typeof data.signBaselines !== 'object') data.signBaselines = {};
  if (typeof data.bridgeToken !== 'string' || data.bridgeToken.length < 32) data.bridgeToken = randomBytes(24).toString('hex');
  // 默认端口被占用时 bridge-server 会改用随机端口，main 再把实际端口存回来
  if (!Number.isInteger(data.bridgePort) || data.bridgePort <= 0) data.bridgePort = 47654;

  function save() {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }
  save();

  return {
    get: (k) => data[k],
    set(k, v) { data[k] = v; save(); },
    rpcsOf: (key) => (Array.isArray(data.rpcs[key]) ? data.rpcs[key] : []),
    setRpcs(key, urls) { data.rpcs[key] = urls; save(); },
    isPermitted: (origin) => Object.hasOwn(data.permissions, origin),
    permit(origin) { data.permissions[origin] = Date.now(); save(); },
    revoke(origin) { delete data.permissions[origin]; save(); },
    baselines: {
      get: (origin) => data.signBaselines[origin] || null,
      set(origin, files) { data.signBaselines[origin] = files; save(); },
    },
    permittedOrigins: () => Object.keys(data.permissions),
  };
}
