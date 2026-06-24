const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let autoSaveTimer = null;

// ── Shared recent files (Jain Office Suite) ─────────────────────────────────
const RECENT_FILE = path.join(app.getPath('appData'), 'JainOfficeSuite', 'recent.json');

function addToRecentSuite(filePath) {
  try {
    const dir = path.dirname(RECENT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let list = [];
    if (fs.existsSync(RECENT_FILE)) {
      list = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    }
    list = list.filter(function (r) { return r.path !== filePath; });
    list.unshift({ name: path.basename(filePath), path: filePath, app: 'JainSheet', time: Date.now() });
    if (list.length > 10) list = list.slice(0, 10);
    fs.writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 960,
    minHeight: 620,
    title: 'JainSheet',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  async function handleClose(e) {
    e.preventDefault();
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Close', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Close JainSheet',
      message: 'Close JainSheet?',
      detail: 'Any unsaved changes will be lost.'
    });
    if (choice.response === 0) {
      mainWindow.removeListener('close', handleClose);
      mainWindow.destroy();
    }
  }
  mainWindow.on('close', handleClose);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (autoSaveTimer) clearInterval(autoSaveTimer);
  });

  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => mainWindow.webContents.send('menu-undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => mainWindow.webContents.send('menu-redo') },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => mainWindow.webContents.send('menu-selectall') },
        { type: 'separator' },
        { label: 'Find & Replace', accelerator: 'CmdOrCtrl+H', click: () => mainWindow.webContents.send('menu-findreplace') }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Fix: renderer sends 'trigger-saveas' when Ctrl+S is pressed with no file open
ipcMain.on('menu-new', () => {
  mainWindow.webContents.send('menu-new');
});
ipcMain.on('trigger-saveas', async (event) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'D:\\JainSheet\\Book1',
    filters: [
      { name: 'Excel Workbook (.xlsx)', extensions: ['xlsx'] },
      { name: 'Excel 97-2003 (.xls)', extensions: ['xls'] },
      { name: 'JainSheet File (.json)', extensions: ['json'] },
      { name: 'CSV File (.csv)', extensions: ['csv'] }
    ]
  });
  if (!result.canceled) {
    mainWindow.webContents.send('menu-saveas', result.filePath);
  }
});

ipcMain.on('write-file', (event, { filePath, content, isBuffer }) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (isBuffer) {
      fs.writeFileSync(filePath, Buffer.from(content, 'base64'));
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
    }
    if (filePath) addToRecentSuite(filePath);
    event.reply('write-file-done', { success: true });
  } catch (err) {
    event.reply('write-file-done', { success: false, error: err.message });
  }
});

ipcMain.on('autosave-data', (event, { filePath, content }) => {
  if (filePath && content) {
    try { fs.writeFileSync(filePath, content, 'utf8'); } catch (e) {}
  }
});

app.whenReady().then(() => {
  createWindow();

  // Open file passed via command-line argument.
  // When launched by JainOffice launcher: electron.exe appDir filePath
  // process.argv shape: [electron.exe, appDir, filePath]
  // So the file is always at argv[2].
  const argFile = (function () {
    const candidate = process.argv[2];
    if (!candidate) return null;
    const ext = candidate.split('.').pop().toLowerCase();
    if (ext === 'xlsx' || ext === 'xls') return candidate;
    return null;
  })();

  if (argFile) {
    mainWindow.webContents.once('did-finish-load', function () {
      setTimeout(function () {
        try {
          const ext      = argFile.split('.').pop().toLowerCase();
          const isBinary = (ext === 'xlsx' || ext === 'xls');
          const content  = isBinary
            ? fs.readFileSync(argFile).toString('base64')
            : fs.readFileSync(argFile, 'utf8');
          mainWindow.webContents.send('menu-open', { content, filePath: argFile, isBinary });
          addToRecentSuite(argFile);
        } catch (e) {}
      }, 600);
    });
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });