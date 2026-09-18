/**
 * 端口设置窗口的 preload —— 只暴露三个必要方法，不开 nodeIntegration。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  get: () => ipcRenderer.invoke('settings:get'),
  savePort: (port) => ipcRenderer.invoke('settings:save-port', port),
  openDataFolder: () => ipcRenderer.invoke('settings:open-data-folder'),
});
