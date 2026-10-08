const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('koda', {
  folder: () => ipcRenderer.invoke('folder'),
  run: request => ipcRenderer.invoke('run', request),
  history: () => ipcRenderer.invoke('history'),
  report: () => ipcRenderer.invoke('report'),
  onLog: callback => ipcRenderer.on('log', (_event, text) => callback(text)),
});
