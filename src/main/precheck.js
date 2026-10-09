// 发布前预检查：上链之前，在本机找出「上链后才会发现」的问题。纯函数，不依赖 Electron。
//
// precheck({files, skipped, truncated, read, external, tr}) → {items, summary, card}
//   files      [{path, size}]，本地文件夹里会上传的全部文件（local-site.js 的 list）
//   read(path) → Promise<Uint8Array | null>，读文件内容
//   external   预览页面运行时实际加载过的外部资源（page-audit.js 的 externalOf），可选
//   items      [{level, text}]：error 必须改（传不上去或传上去打不开）、warn 能传但有坑、info 优化建议
//   summary    {files, bytes, txs}：上传全部文件要的交易笔数（每 24 KB 一笔）
//   card       目录卡片预览：{title, category, categoryFrom, categoryWhy, logo, cover}
//
// 规则和链上一致：单文件最多 350 块（config.js MAX_FILE_BYTES）；目录收录要有 index.html，
// 首页超过 256 KB 不取标题，logo / cover 超过 50 KB 不显示（directory.js）。

import { MAX_FILE_BYTES } from './config.js';
import { normalizePath } from './address.js';
import { extractTitle, IMAGE_FILES, IMAGE_MAX_BYTES, MANIFEST_PATH } from './directory.js';
import { classify, declaredCategory, CATEGORIES } from './category.js';

export const CHUNK_SIZE = 24000;
const TITLE_MAX_BYTES = 256 * 1024;
// 只扫这么大以内的 HTML / CSS 找引用，太大的多半是打包产物，不逐个看
const SCAN_MAX_BYTES = 2 * 1024 * 1024;
const MAX_LISTED = 5;

const fill = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (all, k) => (Object.hasOwn(v, k) ? String(v[k]) : all)) : s);
export const txsOf = (size) => Math.max(1, Math.ceil(size / CHUNK_SIZE));
const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

/** PNG / JPEG 的宽高；认不出返回 null */
export function imageSize(b) {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { type: 'png', width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      // SOF0–SOF15，除了 DHT(C4)、JPG(C8)、DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
  }
  return null;
}

const BASE = 'http://site.invalid/';
// 不是资源的写法：锚点、数据网址、邮件、脚本伪协议、模板占位
const IGNORE = /^(#|data:|blob:|mailto:|tel:|javascript:|about:|\{\{|\$\{)/i;
// 只是跳转、不会自动加载的标签：外链不算外部资源
const NAV_TAGS = new Set(['a', 'area', 'form']);

/** HTML / CSS 里引用的地址：[{tag, ref}] */
export function referencesOf(text, isCss) {
  const out = [];
  if (!isCss) {
    for (const m of text.matchAll(/<([a-z][\w-]*)\b[^>]*?\s(?:src|href|action)\s*=\s*["']([^"']*)["']/gi)) out.push({ tag: m[1].toLowerCase(), ref: m[2].trim() });
  }
  for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) out.push({ tag: 'css', ref: m[2].trim() });
  for (const m of text.matchAll(/@import\s+(['"])([^'"]+)\1/gi)) out.push({ tag: 'css', ref: m[2].trim() });
  return out.filter((r) => r.ref && !IGNORE.test(r.ref));
}

/** 相对 from 文件解析引用：站内返回 {path}，外部返回 {external: origin}，解析不了返回 null */
export function resolveRef(from, ref) {
  let u;
  try { u = new URL(ref, BASE + from); } catch { return null; }
  if (u.origin !== new URL(BASE).origin) return /^(https?|wss?):$/.test(u.protocol) ? { external: u.origin } : null;
  try { return { path: normalizePath(u.pathname) }; } catch { return null; }
}

const list = (arr, tr) => arr.slice(0, MAX_LISTED).join(tr('、')) + (arr.length > MAX_LISTED ? tr(' 等 {n} 个', { n: arr.length }) : '');

export async function precheck({ files, skipped = [], truncated = false, read, external = [], tr = fill }) {
  const items = [];
  const add = (level, text) => items.push({ level, text });
  const byPath = new Map(files.map((f) => [f.path, f]));
  const summary = { files: files.length, bytes: files.reduce((s, f) => s + f.size, 0), txs: files.reduce((s, f) => s + txsOf(f.size), 0) };
  const card = { title: '', category: 'other', categoryFrom: 'guess', categoryWhy: [], logo: null, cover: null };

  // ---- 1. 能不能上链
  if (truncated) add('error', tr('文件超过 {n} 个，只检查了前 {n} 个。是不是选错了文件夹？应该选构建产物（例如 dist/）', { n: files.length }));
  const index = byPath.get('index.html');
  if (!index) add('error', tr('根目录没有 index.html：网站打不开，目录也不会收录'));
  const empty = files.filter((f) => f.size === 0).map((f) => f.path);
  if (empty.length) add('error', tr('空文件不能上链：{list}', { list: list(empty, tr) }));
  const huge = files.filter((f) => f.size > MAX_FILE_BYTES).map((f) => `${f.path}（${kb(f.size)}）`);
  if (huge.length) add('error', tr('单个文件最多 {max}（350 块），这些超了：{list}', { max: kb(MAX_FILE_BYTES), list: list(huge, tr) }));
  const badName = files.filter((f) => /[\u0000-\u001f\\?#%]/.test(f.path) || f.path.length > 200).map((f) => f.path);
  if (badName.length) add('error', tr('文件名里有 ?、#、%、\\ 或控制字符，或者路径太长，网址里打不开：{list}', { list: list(badName, tr) }));
  if (skipped.some((p) => p === 'node_modules/' || p.endsWith('/node_modules/'))) add('warn', tr('文件夹里有 node_modules，已跳过。通常应该选构建产物（例如 dist/），而不是源码目录'));
  const hidden = skipped.filter((p) => !p.endsWith('node_modules/'));
  if (hidden.length) add('info', tr('隐藏文件和符号链接不会上传：{list}', { list: list(hidden, tr) }));

  // ---- 2. 上链后能不能正常运行：HTML / CSS 里引用的文件要存在；外部资源不受链上校验保护
  const missing = new Set();
  const extRisky = new Set();
  const extPlain = new Set();
  for (const f of files) {
    const isCss = /\.css$/i.test(f.path);
    if (!(isCss || /\.html?$/i.test(f.path)) || f.size > SCAN_MAX_BYTES) continue;
    const bytes = await read(f.path);
    if (!bytes) continue;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    for (const { tag, ref } of referencesOf(text, isCss)) {
      const r = resolveRef(f.path, ref);
      if (!r) continue;
      if (r.external) {
        if (NAV_TAGS.has(tag)) continue;
        (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed' ? extRisky : extPlain).add(r.external);
      } else if (!byPath.has(r.path) && !byPath.has(r.path + '/index.html')) missing.add(`/${r.path}（${f.path}）`);
    }
  }
  for (const e of external) (e.risky ? extRisky : extPlain).add(e.origin);
  for (const o of extRisky) extPlain.delete(o);
  if (missing.size) add('warn', tr('引用的文件不存在，上链后会 404：{list}', { list: list([...missing], tr) }));
  if (extRisky.size) add('warn', tr('用了不在链上的外部脚本或接口：{list}。上链后「链上」按钮会显示「含外部脚本」，外部服务失效时网站也会出问题；建议把脚本下载下来一起上传', { list: list([...extRisky], tr) }));
  if (extPlain.size) add('info', tr('加载了外部图片、字体或样式：{list}。不影响校验，但外部服务失效时会显示不全', { list: list([...extPlain], tr) }));

  // ---- 3. 在目录里显示得好不好
  if (index) {
    const bytes = await read('index.html');
    if (bytes) {
      card.title = extractTitle(bytes);
      if (index.size > TITLE_MAX_BYTES) add('warn', tr('index.html 有 {size}，超过 256 KB，目录里会显示「（没有标题）」。可以把脚本和样式拆成单独的文件', { size: kb(index.size) }));
      else if (!card.title) add('warn', tr('index.html 没有 <title>，目录里会显示「（没有标题）」'));
      const g = classify(card.title, index.size <= TITLE_MAX_BYTES ? bytes : null);
      Object.assign(card, { category: g.category, categoryWhy: g.why });
    }
  }
  const man = byPath.get(MANIFEST_PATH);
  if (man) {
    let declared = null;
    try { declared = declaredCategory(JSON.parse(new TextDecoder().decode(await read(MANIFEST_PATH)))); } catch { /* 下面提示 */ }
    if (declared) Object.assign(card, { category: declared, categoryFrom: 'declared', categoryWhy: [] });
    else add('warn', tr('deweb.json 不是合法的 JSON，或 category 不是 {list} 之一，会按推测的分类显示', { list: CATEGORIES.join(' / ') }));
  } else {
    add('info', tr('没有 deweb.json，分类是推测的。可以在根目录放 deweb.json 声明分类，例如 {"category": "game"}'));
  }
  const want = { logo: { ratio: 1, text: tr('正方形，推荐 256×256') }, cover: { ratio: 1.6, text: tr('16:10，推荐 640×400') } };
  for (const [kind, names] of Object.entries(IMAGE_FILES)) {
    const path = names.find((n) => byPath.has(n));
    if (!path) continue;
    const f = byPath.get(path);
    if (f.size > IMAGE_MAX_BYTES) { add('warn', tr('{path} 有 {size}，超过 50 KB，目录卡片上不会显示', { path, size: kb(f.size) })); continue; }
    const bytes = await read(path);
    const dim = bytes && imageSize(bytes);
    const ext = path.endsWith('.png') ? 'png' : 'jpeg';
    if (!dim || dim.type !== ext) { add('warn', tr('{path} 不是有效的 {type} 图片', { path, type: ext.toUpperCase() })); continue; }
    if (Math.abs(dim.width / dim.height - want[kind].ratio) > 0.05) add('info', tr('{path} 是 {w}×{h}，建议{want}', { path, w: dim.width, h: dim.height, want: want[kind].text }));
    if (kind === 'logo' && (dim.width > 512 || dim.height > 512)) add('info', tr('{path} 是 {w}×{h}，最大 512×512', { path, w: dim.width, h: dim.height }));
    card[kind] = { path, size: f.size, width: dim.width, height: dim.height, type: ext };
  }
  if (!card.logo && !card.cover) add('info', tr('没有 logo.png 或 cover.png，卡片上会显示标题的首字'));

  // ---- 4. 要花多少钱
  const small = files.filter((f) => f.size < CHUNK_SIZE / 2 && !/\.(png|jpe?g|gif|webp|ico|svg)$/i.test(f.path) && f.path !== 'index.html' && f.path !== MANIFEST_PATH);
  if (small.length >= 5) add('info', tr('有 {n} 个小脚本或样式文件，每个都要单独一笔交易。用打包工具合并成一两个文件，可以少发 {save} 笔左右', { n: small.length, save: small.length - 2 }));

  const order = { error: 0, warn: 1, info: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  return { items, summary, card };
}
