// Application Windows : une fenêtre qui ouvre le serveur de jeu configuré.
const { app, BrowserWindow, Menu, ipcMain, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');

// Adresse par défaut (modifiable au premier lancement ou via le menu).
const DEFAULT_SERVER = process.env.LOUP_SERVER_URL || '';
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return { serverUrl: DEFAULT_SERVER };
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

let win;

function openGame() {
  const { serverUrl } = readConfig();
  if (serverUrl) win.loadURL(serverUrl);
  else win.loadFile(path.join(__dirname, 'setup.html'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: '#0f1226',
    title: 'Loup-Garou',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });

  // Les liens externes s'ouvrent dans le navigateur.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Page d'erreur si le serveur est injoignable.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return; // navigation annulée
    win.loadFile(path.join(__dirname, 'setup.html'), { query: { error: `Impossible de joindre ${url} (${desc})` } });
  });

  openGame();
}

app.whenReady().then(() => {
  // Autorise le micro (et uniquement lui) pour le chat vocal.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === 'media' && (details.mediaTypes || []).every((t) => t === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  ipcMain.handle('get-config', () => readConfig());
  ipcMain.handle('set-server', (_e, url) => {
    writeConfig({ ...readConfig(), serverUrl: url });
    openGame();
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Partie',
        submenu: [
          { label: 'Accueil', accelerator: 'CmdOrCtrl+H', click: () => openGame() },
          { label: 'Changer de serveur…', click: () => win.loadFile(path.join(__dirname, 'setup.html')) },
          { type: 'separator' },
          { role: 'reload', label: 'Recharger' },
          { role: 'togglefullscreen', label: 'Plein écran' },
          { type: 'separator' },
          { role: 'quit', label: 'Quitter' },
        ],
      },
      { label: 'Affichage', submenu: [{ role: 'zoomIn', label: 'Zoom +' }, { role: 'zoomOut', label: 'Zoom −' }, { role: 'resetZoom', label: 'Taille normale' }, { role: 'toggleDevTools', label: 'Outils de développement' }] },
    ]),
  );

  createWindow();
});

app.on('window-all-closed', () => app.quit());
