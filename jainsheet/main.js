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
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  mainWindow.loadFile('index.html');
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
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('menu-new')
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              defaultPath: 'D:\\JainSheet',
              filters: [
                { name: 'JainSheet Files', extensions: ['json'] },
                { name: 'Excel Files', extensions: ['xlsx', 'xls'] },
                { name: 'CSV Files', extensions: ['csv'] },
                { name: 'All Files', extensions: ['*'] }
              ],
              properties: ['openFile']
            });
            if (!result.canceled && result.filePaths.length > 0) {
              const filePath = result.filePaths[0];
              const ext = path.extname(filePath).toLowerCase();
              // xlsx/xls are binary — read as base64 so SheetJS can decode correctly
              const isBinary = (ext === '.xlsx' || ext === '.xls');
              const content = isBinary
                ? fs.readFileSync(filePath).toString('base64')
                : fs.readFileSync(filePath, 'utf8');
              mainWindow.webContents.send('menu-open', { content, filePath, isBinary });
              addToRecentSuite(filePath);
            }
          }
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu-save')
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: async () => {
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
          }
        },
        { type: 'separator' },
        {
          label: 'Import CSV...',
          accelerator: 'CmdOrCtrl+I',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              defaultPath: 'D:\\JainSheet',
              filters: [{ name: 'CSV Files', extensions: ['csv'] }],
              properties: ['openFile']
            });
            if (!result.canceled && result.filePaths.length > 0) {
              const content = fs.readFileSync(result.filePaths[0], 'utf8');
              mainWindow.webContents.send('menu-importcsv', { content, filePath: result.filePaths[0] });
            }
          }
        },
        {
          label: 'Export as CSV',
          click: async () => {
            const result = await dialog.showSaveDialog(mainWindow, {
              defaultPath: 'D:\\JainSheet\\Export.csv',
              filters: [{ name: 'CSV', extensions: ['csv'] }]
            });
            if (!result.canceled) mainWindow.webContents.send('menu-exportcsv', result.filePath);
          }
        },
        {
          label: 'Print / Export PDF',
          accelerator: 'CmdOrCtrl+P',
          click: async () => {
            const result = await dialog.showSaveDialog(mainWindow, {
              defaultPath: 'D:\\JainSheet\\JainSheet-Print.pdf',
              filters: [{ name: 'PDF', extensions: ['pdf'] }]
            });
            if (!result.canceled) {
              const pdfData = await mainWindow.webContents.printToPDF({
                printBackground: true, pageSize: 'A4', landscape: false, marginsType: 1
              });
              fs.writeFileSync(result.filePath, pdfData);
              shell.openPath(result.filePath);
            }
          }
        },
        { type: 'separator' },
        { label: 'Exit', role: 'quit' }
      ]
    },
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
    },
    {
      label: 'Sheet',
      submenu: [
        { label: 'Add New Sheet', accelerator: 'CmdOrCtrl+Shift+N', click: () => mainWindow.webContents.send('menu-addsheet') },
        { label: 'Rename Sheet', click: () => mainWindow.webContents.send('menu-renamesheet') },
        { label: 'Delete Sheet', click: () => mainWindow.webContents.send('menu-deletesheet') },
        { label: 'Duplicate Sheet', click: () => mainWindow.webContents.send('menu-duplicatesheet') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => mainWindow.webContents.send('menu-zoomin') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => mainWindow.webContents.send('menu-zoomout') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.send('menu-zoomreset') },
        { type: 'separator' },
        { label: 'Toggle Gridlines', click: () => mainWindow.webContents.send('menu-gridlines') },
        { label: 'Toggle Dark Mode', accelerator: 'CmdOrCtrl+Shift+D', click: () => mainWindow.webContents.send('menu-darkmode') },
        { type: 'separator' },
        { label: 'Toggle DevTools', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Auto-Save Every 2 Minutes',
          type: 'checkbox',
          checked: false,
          click: (item) => {
            if (item.checked) {
              autoSaveTimer = setInterval(() => mainWindow.webContents.send('menu-autosave'), 120000);
            } else {
              if (autoSaveTimer) clearInterval(autoSaveTimer);
              autoSaveTimer = null;
            }
          }
        },
        { label: 'Open JainSheet Folder', click: () => shell.openPath('D:\\JainSheet') }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: () => mainWindow.webContents.send('menu-shortcuts') },
        { type: 'separator' },
        {
          label: 'About JainSheet',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About JainSheet',
            message: 'JainSheet v2.1.0',
            detail: 'A powerful desktop spreadsheet application.\nBuilt with Electron.\n\nFeatures: Multi-sheet, XLSX Save, Dark Mode,\nFull Formula Engine, Charts, CSV Import/Export\n\nProject Path: D:\\JainSheet\n\u00a9 2025-2026 JainSheet'
          })
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Fix: renderer sends 'trigger-saveas' when Ctrl+S is pressed with no file open
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });
