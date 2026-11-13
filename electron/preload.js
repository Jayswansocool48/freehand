'use strict';
// Tiny bridge so the page can recolour the native window buttons (min / max / close) to match its theme.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('freehandShell', {
  platform: process.platform,
  setChrome: (c) => ipcRenderer.send('freehand:chrome', { color: String(c && c.color), symbolColor: String(c && c.symbolColor) }),
});
