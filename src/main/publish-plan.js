// 发布计划：对比本地文件和链上文件信息，决定每个文件怎么传。纯函数，不依赖 Electron。
//
// 规则和官方发布页一致：链上文件只增不改。内容相同的复用，传了一半的接着传；
// 内容不同的只有 index.html 可以在最后整个替换（只能单块），其他文件算冲突，要改文件名。
// index.html 永远最后传：传到一半时，旧首页和它引用的旧文件都还在，网站不会坏。

import { guessType } from './tape-protocol.js';

export const CHUNK_BYTES = 24000;
const INDEX = 'index.html';

/** 文件要几块；空文件也要一笔 putFile */
export const chunksOf = (size) => Math.max(1, Math.ceil(size / CHUNK_BYTES));
/** 第 i 块的字节 */
export const chunkOf = (bytes, i) => bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);

/**
 * files = [{path, bytes, sha256}]；infos 和 files 一一对应，是 chain.fileInfo 的结果（不存在为 null）。
 * 返回 {rows, conflicts, transactions, uploadBytes, reused}：
 *   rows      [{path, bytes, sha256, contentType, chunks, action, from, remaining, uploadBytes}]
 *             action 是 create / append / replace / reuse；from 是从第几块开始传
 *   conflicts [{path, reason}]，reason 是 changed / index-too-big / corrupt；有冲突就不能发布
 */
export function planPublish(files, infos) {
  const rows = [];
  const conflicts = [];
  files.forEach((f, i) => {
    const info = infos[i];
    const contentType = guessType(f.path);
    const chunks = chunksOf(f.bytes.length);
    const base = { path: f.path, bytes: f.bytes, sha256: f.sha256, contentType, chunks };
    if (!info) {
      rows.push({ ...base, action: 'create', from: 0, remaining: chunks, uploadBytes: f.bytes.length });
      return;
    }
    const same = String(info.sha256).toLowerCase() === String(f.sha256).toLowerCase() && info.contentType === contentType;
    if (!same) {
      if (f.path !== INDEX) conflicts.push({ path: f.path, reason: 'changed' });
      else if (f.bytes.length > CHUNK_BYTES) conflicts.push({ path: f.path, reason: 'index-too-big' });
      else rows.push({ ...base, action: 'replace', from: 0, remaining: 1, uploadBytes: f.bytes.length });
      return;
    }
    const count = info.chunkCount;
    if (count > chunks || info.size !== Math.min(count * CHUNK_BYTES, f.bytes.length)) {
      conflicts.push({ path: f.path, reason: 'corrupt' });
      return;
    }
    if (count === chunks) rows.push({ ...base, action: 'reuse', from: count, remaining: 0, uploadBytes: 0 });
    else rows.push({ ...base, action: 'append', from: count, remaining: chunks - count, uploadBytes: f.bytes.length - info.size });
  });
  const order = (a, b) => (a.path === INDEX) - (b.path === INDEX) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  rows.sort(order);
  conflicts.sort(order);
  return {
    rows,
    conflicts,
    transactions: rows.reduce((n, r) => n + r.remaining, 0),
    uploadBytes: rows.reduce((n, r) => n + r.uploadBytes, 0),
    reused: rows.filter((r) => r.action === 'reuse').length,
  };
}

/** 按顺序列出每一笔上传：[{path, index, row}]；index 为 0 的用 putFile，其余用 appendChunk */
export function stepsOf(plan) {
  const out = [];
  for (const row of plan.rows) for (let i = row.from; i < row.from + row.remaining; i++) out.push({ path: row.path, index: i, row });
  return out;
}
