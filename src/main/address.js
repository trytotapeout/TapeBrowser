// 地址栏输入解析。纯函数，不依赖 Electron，便于单元测试。
//
// 规范网址：tape://<ID>-<处理器>/<路径>，例如 tape://4454-0/
//   主机名用连字符而不是点：Chromium 会把 "4454.0" 这种全数字主机名当成 IPv4 地址改写。
//
// 输入分类（parseInput 的 kind）：
//   site   明确的电路：4454-0、4454.0、4454.0.tape、#4454@0、tape://4454-0/a.html
//   digits 不带分隔符的一串数字：12330、12330.tape、tape://12330 → 枚举所有切分
//   wallet 0x 开头的 40 位十六进制钱包地址 → 扫描钱包
//   url    http(s):// 或看起来像域名的输入
//   search 其他（第一版不接搜索引擎，提示无法识别）

export const siteHost = (tokenId, cpu) => `${tokenId}-${cpu}`;
export const siteUrl = (tokenId, cpu, path = '') => `tape://${siteHost(tokenId, cpu)}/${path}`;
export const siteLabel = (tokenId, cpu) => `${tokenId}.${cpu}.tape`;

function validSite(idStr, cpuStr) {
  if (!/^[1-9]\d*$/.test(idStr) || !/^(0|[1-9]\d*)$/.test(cpuStr)) return null;
  const tokenId = Number(idStr);
  const cpu = Number(cpuStr);
  if (!Number.isSafeInteger(tokenId) || !Number.isSafeInteger(cpu)) return null;
  return { tokenId, cpu };
}

/** 解析规范主机名 4454-0（协议处理器用）；兼容 4454.0 与 4454.0.tape */
export function parseHost(host) {
  const m = String(host).toLowerCase().match(/^(\d+)[-.](\d+)(?:\.tape)?$/);
  return m ? validSite(m[1], m[2]) : null;
}

/**
 * 把一串数字切成 ID + 处理器编号的所有合法组合（只做字面合法性检查：
 * ID 不能以 0 开头、处理器编号除了 "0" 不能以 0 开头）。处理器是否存在由调用方查链。
 * "12330" → [1.2330, 12.330, 123.30, 1233.0]
 */
export function splitDigits(digits) {
  const out = [];
  for (let i = 1; i < digits.length; i++) {
    const s = validSite(digits.slice(0, i), digits.slice(i));
    if (s) out.push(s);
  }
  return out;
}

/** 规范路径：去掉开头的 /，空路径和以 / 结尾的路径补 index.html */
export function normalizePath(pathname) {
  let p = decodeURIComponent(String(pathname || '/')).replace(/^\/+/, '');
  if (p === '' || p.endsWith('/')) p += 'index.html';
  return p;
}

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
    if (site) return { kind: 'site', ...site, url: `tape://${siteHost(site.tokenId, site.cpu)}${rest.startsWith('/') ? rest : '/' + rest}` };
    return { kind: 'search', text: s };
  }

  // #4454@0[/path]
  let m = s.match(/^#(\d+)@(\d+)(\/.*)?$/);
  // 4454-0 / 4454.0 / 4454.0.tape / #4454.0，可带 /path
  if (!m) m = s.match(/^#?(\d+)[-.](\d+)(?:\.tape)?(\/.*)?$/i);
  if (m) {
    const site = validSite(m[1], m[2]);
    if (site) return { kind: 'site', ...site, url: siteUrl(site.tokenId, site.cpu) + (m[3] || '/').slice(1) };
  }

  // 12330 / 12330.tape
  const dm = s.match(/^(\d+)(?:\.tape)?$/i);
  if (dm) return { kind: 'digits', digits: dm[1], path: '/' };

  if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s };
  // 像域名：最后一段要有字母（排除 0.0 这类）
  if (/^([\w-]+\.)+[a-zA-Z][\w-]*(:\d+)?(\/.*)?$/.test(s)) return { kind: 'url', url: 'https://' + s };
  return { kind: 'search', text: s };
}
