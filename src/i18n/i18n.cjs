// 界面语言：中文写在代码里（同时作为字典的 key），英文在 en.json。没有翻译的文字原样显示中文。
// 主进程和外壳界面的 preload 共用；{name} 是占位符。
'use strict';
const en = require('./en.json');

function create(lang) {
  const dict = lang === 'en' ? en : null;
  return function tr(text, vars) {
    let s = (dict && dict[text]) ?? text;
    if (vars) s = s.replace(/\{(\w+)\}/g, (all, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : all));
    return s;
  };
}

/** 系统语言是中文时用中文，其他用英文 */
const pick = (setting, locale) => (setting === 'zh' || setting === 'en' ? setting : /^zh/i.test(locale || '') ? 'zh' : 'en');

module.exports = { create, pick, en };
