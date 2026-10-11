// 广告位：配置电路 index.html 里的 tape-ads 节点（读取和缓存见 remote-config.js）。纯函数，不依赖 Electron。
//
//   <script type="application/json" id="tape-ads">
//   { "version": 1,
//     "slots": { "home": {...}, "panel": {...} },        home 首页横幅，panel 网站信息面板右侧
//     "placeholder": { "title", "desc", "link" } }       没有广告时显示的招租文字（可选）
//   每个广告：{ title, desc, image（容器里的相对路径）, link（tape:// 或 https://）, until（可选，YYYY-MM-DD，当天结束后不再显示） }
//
// 某个位置写 null、不写或字段不合格：这个位置没有广告，其他位置不受影响。
// 读链一直失败时，上次的广告最多再用 MAX_STALE。

export const SLOTS = ['home', 'panel'];
// 一直读不到时，上次的广告最多再用这么久
export const MAX_STALE = 7 * 24 * 60 * 60 * 1000;
export const IMAGE_MAX_BYTES = 512 * 1024;
const LIMITS = { title: 40, desc: 120, link: 300, image: 200 };
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** tape-ads 节点（已通过 version 检查）→ {slots, placeholder} */
export function parseAds(raw) {
  const slots = {};
  const src = raw?.slots && typeof raw.slots === 'object' ? raw.slots : {};
  for (const k of SLOTS) slots[k] = cleanSlot(src[k]);
  return { slots, placeholder: cleanPlaceholder(raw?.placeholder) };
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

/**
 * 给界面的结果：{ home, panel }，每个位置是
 *   { kind: 'ad', title, desc, link, image }   image 为 true 时界面再调 adImage 取图
 *   { kind: 'placeholder', title, desc, link } 运营方明确没放广告，但配了招租文字
 *   null                                        不显示
 * cached：remote-config 的 section('ads')
 */
export function adsView(cached, now = Date.now()) {
  const out = Object.fromEntries(SLOTS.map((k) => [k, null]));
  const data = cached?.data;
  if (!data || now - cached.readAt > MAX_STALE) return out;
  for (const k of SLOTS) {
    const s = data.slots?.[k];
    if (s && !expired(s, now)) out[k] = { kind: 'ad', title: s.title, desc: s.desc, link: s.link, image: Boolean(s.image) };
    else if (data.placeholder) out[k] = { kind: 'placeholder', ...data.placeholder };
  }
  return out;
}

/** 广告图片：{bytes, type}；没有、读不到或太大返回 null。readFile 是 remote-config 的 readFile */
export async function adImage(cached, slot, readFile, now = Date.now()) {
  const s = SLOTS.includes(slot) && adsView(cached, now)[slot]?.kind === 'ad' ? cached.data.slots[slot] : null;
  if (!s?.image) return null;
  try {
    const f = await readFile(s.image);
    if (!f || f.bytes.length > IMAGE_MAX_BYTES) return null;
    return { bytes: f.bytes, type: IMAGE_TYPES[s.image.split('.').pop().toLowerCase()] };
  } catch { return null; }
}
