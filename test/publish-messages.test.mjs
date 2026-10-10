import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PUBLISH_MESSAGES, translateMessage } from '../src/main/publish-errors.js';

const FILES = [
  'src/main/publisher.js', 'src/main/operator.js', 'src/main/operator-store.js',
  'src/main/publish-service.js', 'src/main/owner-send.js', 'src/main/sites.js',
];
// fail(code, 这些) 是运行时才知道的文字（钱包原样返回的错误、waitReceipt 的参数），不进列表
const DYNAMIC = new Set(['e?.message', 'message']);
// 变量统一写成 {?} 再比较：源码里是 ${path}，列表里是 {path}
const norm = (s) => s.replace(/\{\w+\}/g, '{?}');

/** 读一个字符串字面量（'…' 或 `…${x}…`），返回 [归一化后的文字, 结束位置] */
function literal(src, i) {
  const q = src[i];
  let out = '';
  let j = i + 1;
  while (src[j] !== q) {
    if (src[j] === '\\') { out += src[j + 1]; j += 2; continue; }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      out += '{?}';
      continue;
    }
    out += src[j++];
  }
  return [out, j + 1];
}

/** 源码里所有带错误码抛出的 message */
function thrownMessages() {
  const found = new Set();
  for (const f of FILES) {
    const src = readFileSync(f, 'utf8');
    const consts = new Map([...src.matchAll(/^const ([A-Z_]+) = '([^']*)';/gm)].map((m) => [m[1], m[2]]));
    for (const m of src.matchAll(/\bfail\(\s*(?:E\.)?[A-Z_]+\s*,\s*/g)) {
      const at = m.index + m[0].length;
      if (src[at] === "'" || src[at] === '`') {
        let [text, end] = literal(src, at);
        // '链上状态变了，请重新检查：' + why
        if (/^\s*\+/.test(src.slice(end))) text += '{?}';
        found.add(text);
        continue;
      }
      const expr = /^[\w?.]+(\[\w+\])?/.exec(src.slice(at))[0];
      if (DYNAMIC.has(expr)) continue;
      const map = /^(\w+)\[\w+\]$/.exec(expr);
      if (map) {
        // OWNER_FAIL[kind]：对象字面量里的每个值
        const obj = new RegExp(`const ${map[1]} = \\{([^}]*)\\}`).exec(src);
        assert.ok(obj, `${f}: 找不到 ${map[1]}`);
        for (const v of obj[1].matchAll(/'([^']*)'/g)) found.add(v[1]);
        continue;
      }
      assert.ok(consts.has(expr), `${f}: fail(…, ${expr}) 不是已知的常量`);
      found.add(consts.get(expr));
    }
    // waitReceipt(hash, { message: '…' })：超时时以 LATER 抛出
    for (const m of src.matchAll(/waitReceipt\([^)]*message: '([^']*)'/g)) found.add(m[1]);
  }
  return found;
}

test('PUBLISH_MESSAGES 和源码里带错误码抛出的 message 一致', () => {
  const found = thrownMessages();
  const listed = new Set(PUBLISH_MESSAGES.map(norm));
  assert.deepEqual([...found].filter((m) => !listed.has(m)), [], 'PUBLISH_MESSAGES 缺少');
  assert.deepEqual([...listed].filter((m) => !found.has(m)), [], 'PUBLISH_MESSAGES 里有源码已经不用的');
  assert.equal(new Set(PUBLISH_MESSAGES).size, PUBLISH_MESSAGES.length, '有重复');
});

test('translateMessage：整句查字典，带变量的拆出来填回译文，对不上的原样交给 tr', () => {
  const dict = {
    '退款失败': 'Refund failed',
    '上传 {path} 第 {index} 块模拟失败：{error}': 'Simulating chunk {index} of {path} failed: {error}',
    '钱包没有切换到 {chain}': 'The wallet did not switch to {chain}',
  };
  const tr = (k, vars) => (dict[k] ?? k).replace(/\{(\w+)\}/g, (all, n) => (vars && Object.hasOwn(vars, n) ? vars[n] : all));
  assert.equal(translateMessage('退款失败', tr), 'Refund failed');
  assert.equal(translateMessage('上传 a/b.js 第 3 块模拟失败：execution reverted', tr), 'Simulating chunk 3 of a/b.js failed: execution reverted');
  assert.equal(translateMessage('钱包没有切换到 BNB Chain', tr), 'The wallet did not switch to BNB Chain');
  assert.equal(translateMessage('User denied (4001)', tr), 'User denied (4001)');
  // 变量里的 {x} 不会再被替换
  assert.equal(translateMessage('钱包没有切换到 {chain}', tr), 'The wallet did not switch to {chain}');
});
