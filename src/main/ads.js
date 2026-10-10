// 广告位：内容放在广告电路（BNB 链 1.1196）容器的 index.html 里，不写死、不走中心化接口。不依赖 Electron。
//
// index.html 里放一段 JSON，程序只读这一段，页面其他部分（预览用的 div）不管：
//   <script type="application/json" id="tape-ads">
//   { "version": 1,
//     "slots": { "home": {...}, "panel": {...} },        home 首页横幅，panel 网站信息面板右侧
//     "placeholder": { "title", "desc", "link" } }       没有广告时显示的招租文字（可选）
//   每个广告：{ title, desc, image（容器里的相对路径）, link（tape:// 或 https://）, until（可选，YYYY-MM-DD，当天结束后不再显示） }
//
// 三种结果：
//   ok    读到并解析成功 → 用新内容，写进缓存
//   none  读到了但没有广告（没有首页、首页里没有 tape-ads 节点）→ 清空缓存，立即生效
//   fail  读链失败、电路没开通、JSON 坏了、版本不认识 → 保留上次的结果（最多用 MAX_STALE）
// 单个广告位字段不合格只隐藏这一个位置。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const AD_SITE = { tokenId: 1, cpu: 1196, area: null };
export const AD_CONTAINER = '0x44a6d0956866d848ed76693cec883884b32c1de9';
export const SLOTS = ['home', 'panel'];
export const REFRESH_EVERY = 30 * 60 * 1000;
// 回到首页、打开网站信息面板时，距上次读取超过这么久才重读
export const REFRESH_ON_VIEW = 5 * 60 * 1000;
// 一直读不到时，上次的广告最多再用这么久
export const MAX_STALE = 7 * 24 * 60 * 60 * 1000;
export const IMAGE_MAX_BYTES = 512 * 1024;
const VERSION = 1;
const LIMITS = { title: 40, desc: 120, link: 300, image: 200 };
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const BLOCK = /<script\b[^>]*\bid\s*=\s*["']tape-ads["'][^>]*>([\s\S]*?)<\/script\s*>/i;

/** 解析 index.html：{status: 'ok', data} | {status: 'none'} | {status: 'bad', message} */
export function parseAdsHtml(html) {
  const m = BLOCK.exec(String(html));
  if (!m) return { status: 'none' };
  let raw;
  try { raw = JSON.parse(m[1]); } catch (e) { return { status: 'bad', message: 'JSON: ' + e.message }; }
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return { status: 'bad', message: 'version ' + raw?.version };
  const slots = {};
  const src = raw.slots && typeof raw.slots === 'object' ? raw.slots : {};
  for (const k of SLOTS) slots[k] = cleanSlot(src[k]);
  return { status: 'ok', data: { slots, placeholder: cleanPlaceholder(raw.placeholder) } };
}

const text = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
const optText = (v, max) => (v === undefined || v === null || v === '' ? '' : text(v, max));

/** 只允许 tape:// 和 https:// */
export function cleanLink(v) {
  const s = text(v, LIMITS.link);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'tape:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

/** 容器里的相对路径：不能有 ..、协议、开头的 /，扩展名必须是图片 */
export function cleanImage(v) {
  const s = text(v, LIMITS.image);
  if (!s || s.startsWith('/') || s.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  if (s.split('/').some((p) => !p || p === '.' || p === '..')) return null;
  const ext = s.split('.').pop().toLowerCase();
  return IMAGE_TYPES[ext] ? s : null;
}

/** 一个广告位；明确没有广告（null / 不写）或字段不合格返回 null */
function cleanSlot(v) {
  if (!v || typeof v !== 'object') return null;
  const title = text(v.title, LIMITS.title);
  const link = cleanLink(v.link);
  const desc = optText(v.desc, LIMITS.desc);
  if (!title || !link || desc === null) return null;
  let image = null;
  if (v.image !== undefined && v.image !== null && v.image !== '') {
    image = cleanImage(v.image);
    if (!image) return null;
  }
  let until = null;
  if (v.until !== undefined && v.until !== null && v.until !== '') {
    if (typeof v.until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.until) || Number.isNaN(Date.parse(v.until))) return null;
    until = v.until;
  }
  return { title, desc, link, image, until };
}

function cleanPlaceholder(v) {
  if (!v || typeof v !== 'object') return null;
  const title = text(v.title, LIMITS.title);
  const desc = optText(v.desc, LIMITS.desc);
  if (!title || desc === null) return null;
  // 招租文字可以没有链接
  const link = v.link ? cleanLink(v.link) : null;
  if (v.link && !link) return null;
  return { title, desc, link };
}

/** until 当天（本地时间）结束后过期 */
export function expired(slot, now = Date.now()) {
  if (!slot?.until) return false;
  const [y, m, d] = slot.until.split('-').map(Number);
  return now >= new Date(y, m - 1, d + 1).getTime();
}

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  t.unref?.();
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/**
 * sites：sites.js 的实例；file：缓存文件（userData/ads.json）；onChange(view)：结果变化时通知界面。
 * 缓存内容 {data, readAt}：data 是上次成功读到的广告（null 表示明确没有广告），readAt 是那次读取的时间
 */
export function createAds({ sites, file, onChange = () => {}, now = () => Date.now(), timeout = 8000 }) {
  let cache = null;
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (c && typeof c.readAt === 'number') cache = { data: c.data ?? null, readAt: c.readAt };
  } catch { cache = null; }
  let lastAttempt = 0;
  let inflight = null;
  let lastView = JSON.stringify(view());

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(cache));
      renameSync(file + '.tmp', file);
    } catch { /* 缓存写不进去不影响显示 */ }
  }

  async function container() {
    const s = await sites.site(AD_SITE.tokenId, AD_SITE.cpu, AD_SITE.area);
    if (!s.exists || !s.opened || !s.container) throw new Error('ad site not opened');
    // 电路换了容器就不信任，等这里的地址更新
    if (s.container.toLowerCase() !== AD_CONTAINER) throw new Error('ad container changed: ' + s.container);
    return s.container;
  }

  /** 读一次链：返回 'ok' | 'none' | 'fail' */
  async function load() {
    try {
      const c = await container();
      const f = await sites.readFile(c, 'index.html', AD_SITE.area);
      // stale 是读链失败后用的旧缓存，不当成新结果
      if (f?.source === 'stale') return 'fail';
      const r = f ? parseAdsHtml(new TextDecoder().decode(f.bytes)) : { status: 'none' };
      if (r.status === 'bad') { console.error('ads:', r.message); return 'fail'; }
      cache = { data: r.status === 'ok' ? r.data : null, readAt: now() };
      save();
      return r.status;
    } catch (e) {
      console.error('ads:', e?.message || e);
      return 'fail';
    }
  }

  function emit() {
    const v = view();
    const s = JSON.stringify(v);
    if (s !== lastView) { lastView = s; onChange(v); }
  }

  /** 后台刷新；force=false 时距上次读取不到 REFRESH_ON_VIEW 就不读 */
  function refresh({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && lastAttempt && now() - lastAttempt < REFRESH_ON_VIEW) return Promise.resolve(null);
    lastAttempt = now();
    inflight = withTimeout(load(), timeout).catch(() => 'fail').then((r) => { emit(); return r; }).finally(() => { inflight = null; });
    return inflight;
  }

  /**
   * 给界面的结果：{ home, panel }，每个位置是
   *   { kind: 'ad', title, desc, link, image }   image 为 true 时界面再调 image(slot) 取图
   *   { kind: 'placeholder', title, desc, link } 运营方明确没放广告，但配了招租文字
   *   null                                        不显示
   */
  function view() {
    const out = Object.fromEntries(SLOTS.map((k) => [k, null]));
    const data = cache?.data;
    if (!data || now() - cache.readAt > MAX_STALE) return out;
    for (const k of SLOTS) {
      const s = data.slots?.[k];
      if (s && !expired(s, now())) out[k] = { kind: 'ad', title: s.title, desc: s.desc, link: s.link, image: Boolean(s.image) };
      else if (data.placeholder) out[k] = { kind: 'placeholder', ...data.placeholder };
    }
    return out;
  }

  /** 广告图片：{bytes, type}；没有、读不到或太大返回 null */
  async function image(slot) {
    const s = SLOTS.includes(slot) ? cache?.data?.slots?.[slot] : null;
    if (!s?.image || expired(s, now())) return null;
    try {
      const f = await sites.readFile(await container(), s.image, AD_SITE.area);
      if (!f || f.bytes.length > IMAGE_MAX_BYTES) return null;
      return { bytes: f.bytes, type: IMAGE_TYPES[s.image.split('.').pop().toLowerCase()] };
    } catch { return null; }
  }

  return { refresh, view, image };
}
