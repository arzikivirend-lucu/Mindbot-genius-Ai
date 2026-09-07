// main.js — Electron entry point for Mindbot Genius desktop build
// Boots the existing Express app (server.js) on a local port, then opens
// a native window pointing at it. This is what electron-builder packages
// into the Windows .exe via "npm run build:win".

const path = require('path');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

// When packaged, extraResources copies .env next to the app; make sure
// dotenv (loaded inside server.js) can find it in both dev and packaged mode.
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
if (app.isPackaged) {
  process.chdir(path.join(process.resourcesPath));
}

const PORT = process.env.PORT || 5177;
const expressApp = require('./server.js');

let server;
let mainWindow;

function startServer() {
  return new Promise((resolve) => {
    server = expressApp.listen(PORT, '127.0.0.1', () => {
      console.log(`Mindbot Genius server listening on http://127.0.0.1:${PORT}`);
      resolve();
    });
  });
}

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

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);

  // Open external links (http/https) in the user's default browser
  // instead of inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
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

app.whenReady().then(async () => {
  await startServer();
  createWindow();
  initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (server) server.close();
});
