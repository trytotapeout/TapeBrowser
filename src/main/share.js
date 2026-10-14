// 分享到 X：拼 X 的发帖链接（Web Intent），链接指向产品站上的分享落地页。纯函数，不依赖 Electron。

// 产品站上的分享落地页（github_pages/open/），和外壳界面 ui.js 里的 SHARE_BASE 相同
export const SHARE_BASE = 'https://trytotapeout.github.io/TapeBrowser/open/?';
// TapeKit 官方网关：子域名是网站的主机名（4454-0、1-2-344），没装 TapeBrowser 的人可以直接在浏览器里看
const GATEWAY = '.tapekit.org';
const INTENT = 'https://x.com/intent/post';
// 网站地址：4454.0、1.2.248（区号.ID.处理器），可以带 .tape 和路径。和落地页 open.js 的规则一致
const LABEL = /^([1-9]\d*)\.(?:(\d+)\.)?(0|[1-9]\d*)(?:\.tape)?$/i;
const PATH = /^\/[\w\-./~%]*$/;
// 标题来自网站自己的 HTML，太长就截断，免得把推文挤满
const TITLE_MAX = 60;

/** 路径：首页和不合法的路径都不带 */
const cleanPath = (path) => (path && path !== '/' && path !== '/index.html' && PATH.test(path) ? path : '');

/** 落地页链接；label 不合法返回 null。path 是当前页面的路径，首页不带 */
export function shareLink(label, path = '') {
  const m = LABEL.exec(String(label || '').trim());
  if (!m) return null;
  return SHARE_BASE + String(label).trim().replace(/\.tape$/i, '') + cleanPath(path);
}

/** 官方网关链接：4454.0 → https://4454-0.tapekit.org/；label 不合法返回 null */
export function gatewayLink(label, path = '') {
  const m = LABEL.exec(String(label || '').trim());
  if (!m) return null;
  const host = [m[1], m[2], m[3]].filter((x) => x !== undefined).join('-');
  return 'https://' + host + GATEWAY + (cleanPath(path) || '/');
}

/** 截断标题（按字符，不会切开 emoji），去掉换行 */
export function shortTitle(title) {
  const chars = Array.from(String(title || '').replace(/\s+/g, ' ').trim());
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : chars.join('');
}

// 推文最后的话题标签
export const HASHTAGS = '#tapeout #tapekit #bem';

/** X 发帖链接；text 是推文文案。传了 link 时用 X 的 url 参数，X 会把它接在正文后面；
    想让话题标签排在最后，就把链接写进 text、不传 link */
export function xIntentUrl(text, link) {
  const q = new URLSearchParams({ text: String(text || '') });
  if (link) q.set('url', link);
  return INTENT + '?' + q.toString();
}
