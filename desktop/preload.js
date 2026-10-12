const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loupDesktop', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setServer: (url) => ipcRenderer.invoke('set-server', url),
});
