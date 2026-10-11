// 屏蔽的网站：配置电路 index.html 里的 tape-block 节点（读取和缓存见 remote-config.js）。纯函数，不依赖 Electron。
//
//   <script type="application/json" id="tape-block">
//   { "version": 1,
//     "sites": [ { "site": "15016.30", "reason": "仿冒网站" } ] }
//   site 用名字写：15016.30、1.2.344（带区号）、15016.30.tape 都可以；reason 可选，打开时显示给用户；
//   不写 reason 时只提示「打开这个网站发生了错误」，不说是屏蔽。
//
// 屏蔽后：DeWEB 应用、新上线、钱包扫描、数字查找里不显示；地址栏、书签、链接都打不开。
// 读链失败时一直用上次读到的名单（不像广告那样过期），免得断网时屏蔽失效。

import { parseHost, siteHost } from './address.js';

const MAX_SITES = 5000;
const REASON_MAX = 200;

/** tape-block 节点（已通过 version 检查）→ { sites: { 主机名: reason } }；写错的条目跳过 */
export function parseBlock(raw) {
  const sites = {};
  const list = Array.isArray(raw?.sites) ? raw.sites.slice(0, MAX_SITES) : [];
  for (const item of list) {
    const name = typeof item === 'string' ? item : item?.site;
    const s = typeof name === 'string' ? parseHost(name.trim()) : null;
    if (!s) continue;
    const reason = typeof item?.reason === 'string' ? item.reason.trim().slice(0, REASON_MAX) : '';
    sites[siteHost(s.tokenId, s.cpu, s.area)] = reason;
  }
  return Object.keys(sites).length ? { sites } : null;
}

/**
 * 网站是否被屏蔽：被屏蔽返回原因（可能是空字符串），没有返回 null。
 * cached：remote-config 的 section('block')
 */
export function blockReason(cached, tokenId, cpu, area = null) {
  const sites = cached?.data?.sites;
  if (!sites) return null;
  const r = sites[siteHost(tokenId, cpu, area)];
  return typeof r === 'string' ? r : null;
}
