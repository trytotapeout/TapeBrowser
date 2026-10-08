import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const i18n = createRequire(import.meta.url)('../src/i18n/i18n.cjs');
const CJK = /[一-鿿]/;

/** 代码里所有 tr('…') 和 index.html 里的中文 */
function usedKeys() {
  const keys = new Set();
  for (const f of ['src/main/main.js', 'src/main/tabs.js', 'src/main/risk.js', 'src/main/tip.js', 'src/main/precheck.js', 'src/ui/ui.js']) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\btr\((['"])((?:\\.|(?!\1).)*)\1/g)) keys.add(new Function(`return ${m[1]}${m[2]}${m[1]}`)());
  }
  const html = readFileSync('src/ui/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, '');
  for (const m of html.matchAll(/>([^<>]+)</g)) { const t = m[1].trim(); if (CJK.test(t)) keys.add(t); }
  for (const m of html.matchAll(/(?:title|aria-label|placeholder)="([^"]+)"/g)) if (CJK.test(m[1])) keys.add(m[1]);
  return keys;
}

test('英文字典覆盖界面里所有中文，没有多余的条目，占位符一致', () => {
  const used = usedKeys();
  const missing = [...used].filter((k) => !Object.hasOwn(i18n.en, k));
  assert.deepEqual(missing, [], '缺少英文翻译');
  assert.deepEqual(Object.keys(i18n.en).filter((k) => !used.has(k)), [], '字典里有没用到的条目');
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [k, v] of Object.entries(i18n.en)) assert.deepEqual(vars(v), vars(k), k);
});

test('tr：占位符替换，空翻译不回退到中文，中文界面原样显示', () => {
  const en = i18n.create('en');
  assert.equal(en('标签页 {0}', { 0: 3 }), 'Tab 3');
  assert.equal(en(' 上'), '');
  assert.equal(en('没有翻译的文字'), '没有翻译的文字');
  assert.equal(i18n.create('zh')('标签页 {0}', { 0: 3 }), '标签页 3');
  assert.equal(i18n.pick(null, 'zh-CN'), 'zh');
  assert.equal(i18n.pick(null, 'en-US'), 'en');
  assert.equal(i18n.pick('en', 'zh-CN'), 'en');
});
