// 本地预览：把本机的一个文件夹当成电路网站打开，网址 tape://local-<id>/<路径>。不依赖 Electron。
//
// 和链上网站走同一个 tape:// 处理器（tape-protocol.js），路径规则、内容类型、外部资源检测都一样，
// 开发者在上链前就能看到真实效果。<id> 是文件夹真实路径的 sha256 前 12 位：同一个文件夹每次地址相同
// （localStorage 等按来源隔离的数据不会丢），不同文件夹互不影响；主机名以字母开头，不会和电路编号混淆。
//
// 安全边界：只读用户选中的文件夹；拒绝 ..、隐藏文件（.git、.env 等），
// 并用 realpath 核对，符号链接指到文件夹外面的不读。

import { createHash } from 'node:crypto';
import { realpath, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, isAbsolute } from 'node:path';

const HOST = /^local-([0-9a-f]{12})$/;
/** 上传时跳过的目录：依赖和构建缓存不会是网站文件 */
export const SKIP_DIRS = new Set(['node_modules']);
// 列文件的上限，防止误选了家目录这种巨大的文件夹
export const MAX_LIST = 2000;

/** tape://local-xxxx 的 id；不是本地预览返回 null */
export function parseLocalHost(host) {
  const m = HOST.exec(String(host || '').toLowerCase());
  return m ? m[1] : null;
}
export const localOrigin = (id) => `tape://local-${id}`;
export const isLocalUrl = (url) => /^tape:\/\/local-[0-9a-f]{12}(?:[/?#]|$)/i.test(String(url || ''));

/** 路径里有隐藏段（.git、.env、.DS_Store）或 .. */
const hiddenPath = (path) => path.split('/').some((s) => s.startsWith('.'));

export function createLocalSites() {
  // id → 文件夹的真实路径
  const roots = new Map();

  /** 登记一个文件夹，返回 {id, root, url} */
  async function add(dir) {
    const root = await realpath(dir);
    if (!(await stat(root)).isDirectory()) throw new Error('不是文件夹');
    const id = createHash('sha256').update(root).digest('hex').slice(0, 12);
    roots.set(id, root);
    return { id, root, url: localOrigin(id) + '/' };
  }

  /** 网址 → 文件夹；没登记过返回 null */
  function rootOf(url) {
    const m = /^tape:\/\/([^/?#]+)/i.exec(String(url || ''));
    const id = m && parseLocalHost(m[1]);
    return id ? roots.get(id) || null : null;
  }

  /** 读文件夹里的一个文件（path 已经过 normalizePath）。不存在、越界、隐藏文件都返回 null */
  async function readLocal(root, path) {
    if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || hiddenPath(path)) return null;
    let real;
    try { real = await realpath(join(root, path)); } catch { return null; }
    const rel = relative(root, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    let st;
    try { st = await stat(real); } catch { return null; }
    if (!st.isFile()) return null;
    const bytes = new Uint8Array(await readFile(real));
    const sha256 = '0x' + createHash('sha256').update(bytes).digest('hex');
    // 内容类型留空，由 tape-protocol 按扩展名判断（和上传时写进链上的一致）
    return { info: { size: bytes.length, contentType: '', sha256, updatedAt: Math.floor(st.mtimeMs / 1000) }, bytes, source: 'local' };
  }

  /**
   * 列出文件夹里会上传的全部文件：[{path, size}]，路径用 / 分隔、按字母排序。
   * 跳过隐藏文件和 node_modules（skipped 里记下跳过了什么，预检查会提示）；超过 MAX_LIST 个就截断（truncated）
   */
  async function list(root) {
    const files = [];
    const skipped = [];
    let truncated = false;
    async function walk(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (truncated) return;
        const full = join(dir, e.name);
        const path = relative(root, full).split(sep).join('/');
        if (e.name.startsWith('.') || (e.isDirectory() && SKIP_DIRS.has(e.name))) { skipped.push(path + (e.isDirectory() ? '/' : '')); continue; }
        // 符号链接不跟：上传时也不会跟
        if (e.isSymbolicLink()) { skipped.push(path); continue; }
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          if (files.length >= MAX_LIST) { truncated = true; return; }
          files.push({ path, size: (await stat(full)).size });
        }
      }
    }
    await walk(root);
    return { files, skipped, truncated };
  }

  /** 读一个文件的内容（预检查用，不存在返回 null） */
  async function bytesOf(root, path) {
    return (await readLocal(root, path))?.bytes ?? null;
  }

  return { add, rootOf, readLocal, list, bytesOf, roots: () => [...roots] };
}
