// 首页截图：站长没放 logo / cover 的网站，用户自己打开过首页后，目录卡片显示这张截图。不依赖 Electron。
//
// 只在用户自己打开的标签里截，不在后台替用户加载没去过的网站。截图存在本机 userData/snapshots/，
// 按首页 index.html 的 sha256 对应：首页更新后旧截图不再显示，下次打开时重截。最多留 MAX_SNAPSHOTS 张，
// 超出时删掉最久没截的。
//
// fitJpeg(encode) 把截图压成卡片封面：16:10，依次降宽度和质量，直到不超过 maxBytes。
// encode(width, quality) 由调用方实现（Electron 的 nativeImage），返回 JPEG 字节。

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_SNAPSHOTS = 500;
export const COVER_WIDTHS = [640, 480, 320];
export const COVER_QUALITIES = [80, 70, 60, 50, 40];

/** 依次尝试各个宽度和质量，返回第一个不超过 maxBytes 的 JPEG；都太大返回 null */
export function fitJpeg(encode, maxBytes) {
  for (const w of COVER_WIDTHS) {
    for (const q of COVER_QUALITIES) {
      const bytes = encode(w, q);
      if (bytes && bytes.length <= maxBytes) return bytes;
    }
  }
  return null;
}

/** 截图区域：从页面顶部按 16:10 裁一块（页面比 16:10 宽就裁两边） */
export function coverRect(width, height) {
  width = Math.floor(width); height = Math.floor(height);
  if (width <= 0 || height <= 0) return null;
  const h = Math.min(height, Math.round(width / 1.6));
  const w = Math.min(width, Math.round(h * 1.6));
  return { x: Math.floor((width - w) / 2), y: 0, width: w, height: h };
}

const HOST = /^[0-9a-z-]{1,80}$/;

export function createSnapshots(dir, { now = Date.now, max = MAX_SNAPSHOTS } = {}) {
  const indexFile = join(dir, 'index.json');
  let index = {};
  try { index = JSON.parse(readFileSync(indexFile, 'utf8')) || {}; } catch { index = {}; }

  function save() {
    mkdirSync(dir, { recursive: true });
    writeFileSync(indexFile + '.tmp', JSON.stringify(index));
    renameSync(indexFile + '.tmp', indexFile);
  }

  return {
    /** 有没有和这个首页对应的截图 */
    has: (host, sha256) => Boolean(sha256) && index[host]?.sha256 === sha256,
    /** 读截图字节；首页 sha256 对不上或文件没了返回 null */
    get(host, sha256) {
      if (!HOST.test(host) || !sha256 || index[host]?.sha256 !== sha256) return null;
      try { return new Uint8Array(readFileSync(join(dir, host + '.jpg'))); } catch { return null; }
    },
    put(host, sha256, bytes) {
      if (!HOST.test(host) || !sha256 || !bytes?.length) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, host + '.jpg'), bytes);
      index[host] = { sha256, at: now() };
      const hosts = Object.keys(index);
      if (hosts.length > max) {
        hosts.sort((a, b) => index[a].at - index[b].at);
        for (const h of hosts.slice(0, hosts.length - max)) {
          delete index[h];
          rmSync(join(dir, h + '.jpg'), { force: true });
        }
      }
      save();
    },
  };
}
