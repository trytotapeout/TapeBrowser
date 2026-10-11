// 浏览器配置：放在配置电路（BNB 链 1.1196）容器的 index.html 里，不写死、不走中心化接口。不依赖 Electron。
// 源文件在 tapebrowserconfig 仓库。
//
// index.html 里每类配置一个独立的 JSON 节点，程序只读这些节点，页面其他部分（给人看的预览）不管：
//   <script type="application/json" id="tape-ads">{ "version": 1, ... }</script>     广告位（ads.js）
//   <script type="application/json" id="tape-block">{ "version": 1, ... }</script>   屏蔽的网站（block.js）
// 以后加别的配置就再加一个 tape-xxx 节点，老版本程序不认识的节点直接忽略。
//
// 每段配置各自有三种结果：
//   ok    节点存在、解析成功 → 用新内容
//   none  读到了首页但没有这个节点（或根本没有首页）→ 这一段明确为空，立即生效
//   bad   JSON 坏了、版本不认识 → 这一段保留上次的结果，不影响其他段
// 整个读取失败（读链出错、超时、电路没开通、容器地址变了）时所有段都保留上次的结果。
//
// 缓存（userData/remote-config.json）：{ sections: { ads: {data, readAt}, block: {data, readAt} } }
//   data 是上次成功解析的内容（null 表示明确为空），readAt 是那次读取的时间。每段自己决定旧结果能用多久

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CONFIG_SITE = { tokenId: 1, cpu: 1196, area: null };
export const CONFIG_CONTAINER = '0x44a6d0956866d848ed76693cec883884b32c1de9';
export const REFRESH_EVERY = 30 * 60 * 1000;
// 回到首页、打开网站信息面板时，距上次读取超过这么久才重读
export const REFRESH_ON_VIEW = 5 * 60 * 1000;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 取出 id 对应的 JSON 节点并解析：{status: 'ok', raw} | {status: 'none'} | {status: 'bad', message}。
 * version 不是 1 也算 bad（以后格式变了，老程序不要乱用）
 */
export function extractSection(html, id) {
  const re = new RegExp(`<script\\b[^>]*\\bid\\s*=\\s*["']${escapeRe(id)}["'][^>]*>([\\s\\S]*?)<\\/script\\s*>`, 'i');
  const m = re.exec(String(html));
  if (!m) return { status: 'none' };
  let raw;
  try { raw = JSON.parse(m[1]); } catch (e) { return { status: 'bad', message: `${id} JSON: ${e.message}` }; }
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return { status: 'bad', message: `${id} version ${raw?.version}` };
  return { status: 'ok', raw };
}

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  t.unref?.();
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/**
 * sections：{ ads: { id: 'tape-ads', parse(raw) → data }, ... }。parse 返回 null 表示明确为空
 * onChange()：某段配置的内容变了（包括第一次读到）
 */
export function createRemoteConfig({ sites, file, sections, onChange = () => {}, now = () => Date.now(), timeout = 8000 }) {
  const cache = {};
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    for (const k of Object.keys(sections)) {
      const s = c?.sections?.[k];
      if (s && typeof s.readAt === 'number') cache[k] = { data: s.data ?? null, readAt: s.readAt };
    }
  } catch { /* 没有缓存 */ }
  let lastAttempt = 0;
  let inflight = null;

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify({ sections: cache }));
      renameSync(file + '.tmp', file);
    } catch { /* 缓存写不进去不影响使用 */ }
  }

  /** 配置电路的容器；没开通或地址和写死的不一样时抛错 */
  async function container() {
    const s = await sites.site(CONFIG_SITE.tokenId, CONFIG_SITE.cpu, CONFIG_SITE.area);
    if (!s.exists || !s.opened || !s.container) throw new Error('config site not opened');
    // 电路换了容器就不信任，等这里的地址更新
    if (s.container.toLowerCase() !== CONFIG_CONTAINER) throw new Error('config container changed: ' + s.container);
    return s.container;
  }

  /** 读一次链，返回每段的结果 { ads: 'ok' | 'none' | 'bad' | 'fail', ... } */
  async function load() {
    const result = {};
    let html;
    try {
      const f = await sites.readFile(await container(), 'index.html', CONFIG_SITE.area);
      // stale 是读链失败后用的旧缓存，不当成新结果
      if (f?.source === 'stale') throw new Error('stale');
      html = f ? new TextDecoder().decode(f.bytes) : '';
    } catch (e) {
      console.error('remote config:', e?.message || e);
      for (const k of Object.keys(sections)) result[k] = 'fail';
      return result;
    }
    let changed = false;
    for (const [k, sec] of Object.entries(sections)) {
      const r = extractSection(html, sec.id);
      if (r.status === 'bad') { console.error('remote config:', r.message); result[k] = 'bad'; continue; }
      const data = r.status === 'ok' ? sec.parse(r.raw) : null;
      if (JSON.stringify(data) !== JSON.stringify(cache[k]?.data ?? null)) changed = true;
      cache[k] = { data, readAt: now() };
      result[k] = r.status;
    }
    save();
    if (changed) onChange();
    return result;
  }

  /** 后台刷新；force=false 时距上次读取不到 REFRESH_ON_VIEW 就不读 */
  function refresh({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && lastAttempt && now() - lastAttempt < REFRESH_ON_VIEW) return Promise.resolve(null);
    lastAttempt = now();
    inflight = withTimeout(load(), timeout)
      .catch(() => Object.fromEntries(Object.keys(sections).map((k) => [k, 'fail'])))
      .finally(() => { inflight = null; });
    return inflight;
  }

  /** 某段配置上次成功读到的内容：{data, readAt}；从来没读到过返回 null */
  const section = (k) => cache[k] || null;

  /** 读配置容器里的文件（广告图片等）：{bytes, info} | null */
  async function readFile(path) {
    return sites.readFile(await container(), path, CONFIG_SITE.area);
  }

  return { refresh, section, readFile };
}
