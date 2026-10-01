// 浏览器外壳界面（标签栏、地址栏、设置）的 preload。只开放 ui: 前缀的 IPC 通道。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const NAME = /^[a-zA-Z]+$/;

contextBridge.exposeInMainWorld('tb', {
  platform: process.platform,
  invoke: (name, ...args) => {
    if (!NAME.test(name)) return Promise.reject(new Error('bad channel'));
    return ipcRenderer.invoke('ui:' + name, ...args);
  },
  on: (name, fn) => {
    if (!NAME.test(name)) return;
    ipcRenderer.on('ui:' + name, (_e, ...args) => fn(...args));
  },
});
