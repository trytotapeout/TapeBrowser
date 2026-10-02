// 地址栏输入解析。纯函数，不依赖 Electron，便于单元测试。
//
// 电路网站由 #ID、区号、处理器编号确定（SPEC §2）：BNB Chain 不带区号，X Layer 区号 2，Base 区号 3。
//
//   名字（显示用）   4454.0、1.2.344            链上名字再加 .tape：4454.0.tape、1.2.344.tape
//   规范网址        tape://4454-0/、tape://1-2-344/
//     主机名用连字符而不是点：Chromium 会把 "4454.0" 这种全数字主机名当成 IPv4 地址改写。
//     和官方网关主机名第一段（4454-0.tapekit.org、1-2-344.tapekit.org）写法一致
//
// 输入分类（parseInput 的 kind）：
//   site   明确的电路：4454-0、4454.0、4454.0.tape、#4454@0、1.2.344、#1@2.344、1-2-344、tape://…
//   digits 不带分隔符的一串数字：12330、12330.tape、tape://12330 → 枚举所有切分（含带区号的）
//   wallet 0x 开头的 40 位十六进制钱包地址 → 在所有链上扫描钱包
//   url    http(s):// 或看起来像域名的输入
//   search 其他（第一版不接搜索引擎，提示无法识别）
//   bad    像电路写法但不合规（未分配的区号等），message 说明原因

import { networkByArea, AREAS } from './config.js';

const areaOf = (area) => (area === null || area === undefined ? null : Number(area));
const areaPart = (area, sep) => (areaOf(area) === null ? '' : `${areaOf(area)}${sep}`);

/** 主机名 / 内部键：4454-0、1-2-344 */
export const siteHost = (tokenId, cpu, area = null) => `${tokenId}-${areaPart(area, '-')}${cpu}`;
export const siteUrl = (tokenId, cpu, path = '', area = null) => `tape://${siteHost(tokenId, cpu, area)}/${path}`;
/** 链上名字：4454.0.tape、1.2.344.tape */
export const siteLabel = (tokenId, cpu, area = null) => `${tokenId}.${areaPart(area, '.')}${cpu}.tape`;
/** 同一个网站的唯一键（和主机名相同） */
export const siteKey = (s) => siteHost(s.tokenId, s.cpu, s.area);

const ID = /^[1-9]\d*$/;
const CPU = /^(0|[1-9]\d*)$/;

/**
 * 字面检查：ID 不能以 0 开头，处理器编号除了 "0" 不能以 0 开头，区号必须是已分配的。
 * 返回 {tokenId, cpu, area}；不合法返回 null
 */
function validSite(idStr, cpuStr, areaStr) {
  if (!ID.test(idStr) || !CPU.test(cpuStr)) return null;
  let area = null;
  if (areaStr !== undefined && areaStr !== null) {
    if (!ID.test(areaStr) || !networkByArea(Number(areaStr))) return null;
    area = Number(areaStr);
  }
  const tokenId = Number(idStr);
  const cpu = Number(cpuStr);
  if (!Number.isSafeInteger(tokenId) || !Number.isSafeInteger(cpu)) return null;
  return { tokenId, cpu, area };
}

/** 解析主机名：4454-0、1-2-344（协议处理器用）；兼容 4454.0、1.2.344 与 .tape 后缀 */
export function parseHost(host) {
  const m = String(host).toLowerCase().match(/^(\d+)[-.](?:(\d+)[-.])?(\d+)(?:\.tape)?$/);
  return m ? validSite(m[1], m[3], m[2]) : null;
}

/**
 * 把一串数字切成所有字面合法的组合：ID + 处理器编号（BNB），以及 ID + 区号 + 处理器编号（其他链）。
 * 处理器是否存在由调用方查链。
 * "12248" → [1.2248, 12.248, 122.48, 1224.8, 1.2.248, 12.2.48]
 */
export function splitDigits(digits) {
  const out = [];
  for (let i = 1; i < digits.length; i++) {
    const s = validSite(digits.slice(0, i), digits.slice(i));
    if (s) out.push(s);
  }
  for (const area of AREAS) {
    const a = String(area);
    for (let i = 1; i + a.length < digits.length; i++) {
      if (digits.slice(i, i + a.length) !== a) continue;
      const s = validSite(digits.slice(0, i), digits.slice(i + a.length), a);
      if (s) out.push(s);
    }
  }
  return out;
}

/** 规范路径：去掉开头的 /，空路径和以 / 结尾的路径补 index.html */
export function normalizePath(pathname) {
  let p = decodeURIComponent(String(pathname || '/')).replace(/^\/+/, '');
  if (p === '' || p.endsWith('/')) p += 'index.html';
  return p;
}

const siteResult = (site, rest) => ({ kind: 'site', ...site, url: siteUrl(site.tokenId, site.cpu, '', site.area) + (rest || '/').replace(/^\//, '') });
const badArea = (s) => ({ kind: 'bad', message: `区号 ${s} 没有分配。X Layer 是 2，Base 是 3；BNB Chain 不带区号，例如 4454.0、1.2.344` });

export function parseInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'empty' };

  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { kind: 'wallet', address: s.toLowerCase() };

  // tape://<host>[/path]
  const tm = s.match(/^tape:\/\/([^/?#]+)(.*)$/i);
  if (tm) {
    const host = tm[1].replace(/\.tape$/i, '');
    const rest = tm[2] || '/';
    if (/^\d+$/.test(host)) return { kind: 'digits', digits: host, path: rest };
    const site = parseHost(host);
    if (site) return siteResult(site, rest.startsWith('/') ? rest : '/' + rest);
    const am = host.match(/^\d+[-.](\d+)[-.]\d+$/);
    if (am) return badArea(am[1]);
    return { kind: 'search', text: s };
  }

  // #4454@0、#1@2.344，可带 /path
  let m = s.match(/^#(\d+)@(?:(\d+)\.)?(\d+)(\/.*)?$/);
  // 4454-0、4454.0、4454.0.tape、1.2.344、1-2-344、1.2.344.tape、#4454.0，可带 /path
  if (!m) m = s.match(/^#?(\d+)[-.](?:(\d+)[-.])?(\d+)(?:\.tape)?(\/.*)?$/i);
  if (m) {
    const site = validSite(m[1], m[3], m[2]);
    if (site) return siteResult(site, m[4]);
    if (m[2] !== undefined && ID.test(m[1]) && CPU.test(m[3])) return badArea(m[2]);
  }

  // 12330 / 12330.tape
  const dm = s.match(/^(\d+)(?:\.tape)?$/i);
  if (dm) return { kind: 'digits', digits: dm[1], path: '/' };

  if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s };
  // 像域名：最后一段要有字母（排除 0.0 这类）
  if (/^([\w-]+\.)+[a-zA-Z][\w-]*(:\d+)?(\/.*)?$/.test(s)) return { kind: 'url', url: 'https://' + s };
  return { kind: 'search', text: s };
}
