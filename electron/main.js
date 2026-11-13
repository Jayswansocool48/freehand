'use strict';
const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const { startServer } = require('../src/server');
const { autoUpdater } = require('electron-updater');

// The renderer only ever loads our own localhost UI. On Linux AppImages the Chromium sandbox often
// cannot start (AppArmor / missing setuid helper), so run without it there.
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let backend;

async function createWindow() {
  process.env.FREEHAND_HOME = process.env.FREEHAND_HOME || path.join(app.getPath('userData'), 'data');
  backend = await startServer({ port: 0 });
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f8fafc',
    title: 'Freehand',
    autoHideMenuBar: true,
    // No OS title bar: the app draws its own top bar and only the native min / max / close buttons are overlaid.
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin' ? { titleBarOverlay: { color: '#f8fafc', symbolColor: '#1e293b', height: 48 } } : { trafficLightPosition: { x: 16, y: 16 } }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: process.platform !== 'linux' },
  });
  ipcMain.on('freehand:chrome', (e, c) => {
    const ok = (v) => /^#[0-9a-fA-F]{3,8}$/.test(v);
    if (!win || win.isDestroyed() || e.sender !== win.webContents || !ok(c.color) || !ok(c.symbolColor)) return;
    try { win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: 48 }); win.setBackgroundColor(c.color); } catch { /* not supported on this platform */ }
  });
  Menu.setApplicationMenu(null);
  // Links the agent writes into answers open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${backend.port}/`)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  await win.loadURL(backend.url);
  setupUpdates();
}

// Auto-update from GitHub Releases (installed builds only). Downloads quietly, installs on next quit,
// and asks once when an update is ready.
function setupUpdates() {
  if (!app.isPackaged || process.env.FREEHAND_NO_UPDATE) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => console.error('update check failed:', e && e.message));
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, title: 'Update ready', message: `Freehand ${info.version} is ready`, detail: 'Restart to finish updating. Your tasks and settings are kept.' });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow).catch((e) => { console.error(e); app.quit(); });
app.on('window-all-closed', () => { if (backend) backend.close(); app.quit(); });
