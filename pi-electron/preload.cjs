/* The toolbar's bridge to the main process. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('piShorts', {
  state: () => ipcRenderer.invoke('shorts:state'),
  setFeed: (key) => ipcRenderer.invoke('shorts:set-feed', key),
  reload: () => ipcRenderer.invoke('shorts:reload'),
  openApp: () => ipcRenderer.invoke('shorts:open-app'),
  close: () => ipcRenderer.invoke('shorts:close'),
  openExternal: () => ipcRenderer.invoke('shorts:open-external'),
  resize: (dx) => ipcRenderer.send('shorts:resize', dx),
});
