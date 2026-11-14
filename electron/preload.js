'use strict';
// Tiny bridge: recolour the native window buttons to match the theme, open the data folder, uninstall.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('freehandShell', {
  platform: process.platform,
  setChrome: (c) => ipcRenderer.send('freehand:chrome', { color: String(c && c.color), symbolColor: String(c && c.symbolColor) }),
  openData: () => ipcRenderer.send('freehand:open-data'),
  uninstall: () => ipcRenderer.send('freehand:uninstall'),
});
