// tape:// 协议处理：tape://<ID>-<处理器>/<路径>、tape://<ID>-<区号>-<处理器>/<路径> → 容器里的文件。不依赖 Electron，返回标准 Response。

import { parseHost, normalizePath, siteLabel } from './address.js';

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8', wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
};

function guessType(path) {
  const ext = path.split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function errorPage(status, title, detail) {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;color:#333;max-width:560px;margin:15vh auto;padding:0 24px}
h1{font-size:20px;margin:0 0 8px}p{color:#666;margin:0;word-break:break-all}@media(prefers-color-scheme:dark){body{background:#1e1e1e;color:#ddd}p{color:#999}}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// onServe(origin, path, sha256)：每返回一个文件调用一次（页面审计用，见 page-audit.js）
export function createTapeHandler(sites, { onServe = () => {} } = {}) {
  return async function handle(request) {
    const url = new URL(request.url);
    const site = parseHost(url.hostname);
    if (!site) return errorPage(400, '无法识别的电路地址', url.hostname);
    const label = siteLabel(site.tokenId, site.cpu, site.area);
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorPage(405, '不支持的请求', request.method);

    let path;
    try { path = normalizePath(url.pathname); } catch { return errorPage(400, '路径不合法', url.pathname); }

    try {
      const info = await sites.site(site.tokenId, site.cpu, site.area);
      if (!info.exists) return errorPage(404, `${label} 不存在`, '这个电路还没有铸造，或处理器编号不存在。');
      if (!info.opened || !info.container) return errorPage(404, `${label} 没有开通容器`, '电路持有人还没有开通容器，没有可浏览的网站。');

      let file = await sites.readFile(info.container, path, site.area);
      if (!file && !url.pathname.endsWith('/') && !/\.[^/]+$/.test(path)) {
        // /docs → /docs/（目录下有 index.html 时）
        const dirIndex = await sites.readFile(info.container, path + '/index.html', site.area);
        if (dirIndex) return new Response(null, { status: 301, headers: { location: url.pathname + '/' + url.search } });
      }
      if (!file) return errorPage(404, '文件不存在', `${label} 的容器里没有 /${path}`);

      const type = file.info.contentType || guessType(path);
      const headers = {
        'content-type': type,
        'content-length': String(file.bytes.length),
        'cache-control': 'no-cache',
        'x-tape-sha256': file.info.sha256,
        // chain / cache / stale（读链失败时用的是上次缓存的版本）
        'x-tape-source': file.source || 'chain',
      };
      onServe(`tape://${url.hostname}`, path, file.info.sha256);
      return new Response(request.method === 'HEAD' ? null : file.bytes, { status: 200, headers });
    } catch (e) {
      return errorPage(502, '读取链上数据失败', String(e?.message || e));
    }
  };
}
