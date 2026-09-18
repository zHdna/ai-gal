/**
 * 端口设置窗口的 preload —— 只暴露三个必要方法，不开 nodeIntegration。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  openDataFolder: () => ipcRenderer.invoke('settings:open-data-folder'),
});
