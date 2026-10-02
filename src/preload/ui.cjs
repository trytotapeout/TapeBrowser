// 浏览器外壳界面（标签栏、地址栏、设置）的 preload。只开放 ui: 前缀的 IPC 通道。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const NAME = /^[a-zA-Z]+$/;

// 界面语言和英文字典（中文写在界面代码里，作为字典的 key）
const i18n = ipcRenderer.sendSync('ui:i18n') || { lang: 'zh', en: {} };

contextBridge.exposeInMainWorld('tb', {
  platform: process.platform,
  lang: i18n.lang,
  en: i18n.en,
  invoke: (name, ...args) => {
    if (!NAME.test(name)) return Promise.reject(new Error('bad channel'));
    return ipcRenderer.invoke('ui:' + name, ...args);
  },
  on: (name, fn) => {
    if (!NAME.test(name)) return;
    ipcRenderer.on('ui:' + name, (_e, ...args) => fn(...args));
  },
});
