// main.js — Electron entry point for Mindbot Genius desktop build
// Loads the live production site (which already has every API key configured
// on Vercel) inside a native window, instead of running a local server with
// no keys. This is what electron-builder packages into the Windows .exe via
// "npm run build:win".

const path = require('path');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

const APP_URL = 'https://mindbot-genius-ai.vercel.app/';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'public', 'logo.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(APP_URL);

  // Open external links (http/https) in the user's default browser
  // instead of inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Auto-update ---
// Checks the same GitHub release ("latest-exe") the installer came from.
// If a newer version is published there, it downloads silently in the
// background and installs itself the next time the app restarts.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function initAutoUpdater() {
  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err == null ? 'unknown' : (err.stack || err.message));
  });

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      title: 'Update Ready',
      message: 'Versi baru Mindbot Genius sudah siap dipasang.',
      detail: 'Restart sekarang untuk menggunakan versi terbaru, atau nanti saat kamu menutup aplikasi.',
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  // Only meaningful in the packaged app (skips in `npm run electron` dev mode).
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('checkForUpdates failed:', err);
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
