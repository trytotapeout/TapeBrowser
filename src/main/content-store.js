// 磁盘内容缓存：userData/content-cache/。不依赖 Electron（目录由调用方传入）。
//
//   blobs/<sha 前两位>/<sha>   文件内容，按 sha256 寻址。内容寻址不会过期：网站更新后路径指向新的 sha，
//                              旧内容只是不再被引用，按最近使用时间淘汰
//   index.json                 上次从链上读到的「电路 → 容器」和「容器 + 路径 → 文件信息」，
//                              只在读链失败时兜底使用（离线也能打开访问过的页面）
//
// 读出的内容会重新核对 sha256，磁盘损坏或被改动的文件当作没有缓存。

import { mkdir, readFile, writeFile, rename, readdir, stat, unlink, utimes, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const SHA = /^0x[0-9a-f]{64}$/;
const MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_META = 20000;
const SAVE_DELAY = 2000;

const digest = (bytes) => '0x' + createHash('sha256').update(bytes).digest('hex');

export function createContentStore(dir, { maxBytes = 512 * 1024 * 1024 } = {}) {
  const blobs = join(dir, 'blobs');
  const indexFile = join(dir, 'index.json');
  // sha → {size, at}；启动时扫描磁盘建立
  const sizes = new Map();
  let total = 0;
  // 小的内存层，避免同一页面反复读盘
  const memory = new Map();
  let memoryBytes = 0;
  let meta = { sites: {}, files: {} };
  let timer = null;
  let ready = null;

  const blobPath = (sha) => join(blobs, sha.slice(2, 4), sha.slice(2));

  // 索引很小，构造时同步读入；读链失败兜底时不用等磁盘扫描
  try { meta = { sites: {}, files: {}, ...JSON.parse(readFileSync(indexFile, 'utf8')) }; } catch { /* 首次使用 */ }

  async function init() {
    await mkdir(blobs, { recursive: true });
    for (const sub of await readdir(blobs).catch(() => [])) {
      for (const name of await readdir(join(blobs, sub)).catch(() => [])) {
        const sha = '0x' + name;
        if (!SHA.test(sha)) continue;
        const st = await stat(join(blobs, sub, name)).catch(() => null);
        if (!st) continue;
        sizes.set(sha, { size: st.size, at: st.mtimeMs });
        total += st.size;
      }
    }
  }
  const whenReady = () => (ready ??= init());

  function remember(sha, bytes) {
    if (bytes.length > MEMORY_BYTES / 4) return;
    memory.delete(sha);
    memory.set(sha, bytes);
    memoryBytes += bytes.length;
    for (const [k, v] of memory) {
      if (memoryBytes <= MEMORY_BYTES) break;
      memory.delete(k);
      memoryBytes -= v.length;
    }
  }

  async function evict() {
    if (total <= maxBytes) return;
    const oldest = [...sizes].sort((a, b) => a[1].at - b[1].at);
    for (const [sha, { size }] of oldest) {
      if (total <= maxBytes * 0.9) break;
      await unlink(blobPath(sha)).catch(() => {});
      sizes.delete(sha);
      total -= size;
    }
  }

  function saveMeta() {
    clearTimeout(timer);
    timer = null;
    mkdirSync(dirname(indexFile), { recursive: true });
    writeFileSync(indexFile + '.tmp', JSON.stringify(meta));
    renameSync(indexFile + '.tmp', indexFile);
  }
  function metaChanged() {
    if (timer) return;
    timer = setTimeout(saveMeta, SAVE_DELAY);
    timer.unref?.();
  }
  function trim(obj) {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length - MAX_META; i++) delete obj[keys[i]];
  }

  return {
    /** 按 sha256 取内容；没有或校验不过返回 null */
    async get(sha) {
      sha = String(sha).toLowerCase();
      if (!SHA.test(sha)) return null;
      const hit = memory.get(sha);
      if (hit) { remember(sha, hit); return hit; }
      await whenReady();
      if (!sizes.has(sha)) return null;
      const bytes = await readFile(blobPath(sha)).catch(() => null);
      if (!bytes || digest(bytes) !== sha) {
        await unlink(blobPath(sha)).catch(() => {});
        if (sizes.has(sha)) { total -= sizes.get(sha).size; sizes.delete(sha); }
        return null;
      }
      const now = new Date();
      sizes.get(sha).at = now.getTime();
      utimes(blobPath(sha), now, now).catch(() => {});
      const out = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
      remember(sha, out);
      return out;
    },

    /** 存入已核对过 sha256 的内容 */
    async put(sha, bytes) {
      sha = String(sha).toLowerCase();
      if (!SHA.test(sha)) return;
      remember(sha, bytes);
      await whenReady();
      if (sizes.has(sha)) return;
      const file = blobPath(sha);
      await mkdir(dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      await writeFile(tmp, bytes);
      await rename(tmp, file);
      sizes.set(sha, { size: bytes.length, at: Date.now() });
      total += bytes.length;
      await evict();
    },

    /** 记住上次读到的电路信息 / 文件信息（读链失败时兜底） */
    rememberSite(key, info) { delete meta.sites[key]; meta.sites[key] = info; trim(meta.sites); metaChanged(); },
    lastSite: (key) => meta.sites[key] ?? null,
    rememberFile(container, path, info) {
      const key = `${String(container).toLowerCase()}:${path}`;
      delete meta.files[key];
      meta.files[key] = info;
      trim(meta.files);
      metaChanged();
    },
    lastFile: (container, path) => meta.files[`${String(container).toLowerCase()}:${path}`] ?? null,

    async usage() { await whenReady(); return { bytes: total, files: sizes.size }; },

    async clear() {
      await whenReady();
      clearTimeout(timer);
      timer = null;
      memory.clear();
      memoryBytes = 0;
      sizes.clear();
      total = 0;
      meta = { sites: {}, files: {} };
      await rm(dir, { recursive: true, force: true });
      await mkdir(blobs, { recursive: true });
    },

    flush() { if (timer) saveMeta(); },
  };
}
