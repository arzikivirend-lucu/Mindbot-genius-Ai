const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');

let mainWindow;
let serverProcess;
const PORT = 3000;

function waitForServer(url, retries = 20, delay = 500) {
  return new Promise((resolve, reject) => {
    const check = (n) => {
      http.get(url, () => resolve())
        .on('error', () => {
          if (n <= 0) return reject(new Error('Server tidak bisa jalan'));
          setTimeout(() => check(n - 1), delay);
        });
    };
    check(retries);
  });
}

function startServer() {
  const serverPath = path.join(__dirname, 'server.js');
  const dataPath = app.getPath('userData');

  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      PORT: PORT,
      DATA_PATH: dataPath,
      ELECTRON: 'true'
    },
    silent: true
  });

  serverProcess.stdout?.on('data', d => console.log('[server]', d.toString()));
  serverProcess.stderr?.on('data', d => console.error('[server]', d.toString()));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'public', 'logo.png'),
    title: 'Mindbot Genius',
    backgroundColor: '#0a0c14',
    show: false,
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer(`http://localhost:${PORT}`);
    createWindow();
  } catch(e) {
    console.error('Server gagal start:', e.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
