'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');

// ── Paths ─────────────────────────────────────────────────────────────────────
const IS_PACKED  = app.isPackaged;

const DEV_ROOT   = 'D:\\Jain Office Suite\\Jain Office Suite';

const DOC_DIR    = IS_PACKED
  ? path.join(process.resourcesPath, 'jaindocument')
  : path.join(DEV_ROOT, 'jaindocument');

const SHEET_DIR  = IS_PACKED
  ? path.join(process.resourcesPath, 'jainsheet')
  : path.join(DEV_ROOT, 'jainsheet');

const DOC_EXE    = path.join(DOC_DIR,   'node_modules', 'electron', 'dist', 'electron.exe');
const SHEET_EXE  = path.join(SHEET_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const RECENT_FILE = path.join(app.getPath('appData'), 'JainOfficeSuite', 'recent.json');

// ── File type routing ─────────────────────────────────────────────────────────
const DOC_EXTENSIONS   = new Set(['doc', 'docx']);
const SHEET_EXTENSIONS = new Set(['xls', 'xlsx']);

function getFileArg() {
  // process.argv[0] = electron exe, process.argv[1] = app dir (when packaged)
  // process.argv[2] onwards may contain the file path passed by Windows
  // We scan all args for an existing file path with a known extension
  const args = process.argv.slice(IS_PACKED ? 1 : 2);
  for (const arg of args) {
    if (!arg || arg.startsWith('-') || arg.startsWith('--')) continue;
    // Must look like a file path (has a dot, exists on disk)
    const ext = arg.split('.').pop().toLowerCase();
    if ((DOC_EXTENSIONS.has(ext) || SHEET_EXTENSIONS.has(ext)) && fs.existsSync(arg)) {
      return { filePath: arg, ext };
    }
  }
  return null;
}

// ── Recent files helpers ──────────────────────────────────────────────────────
function loadRecent() {
  try {
    if (fs.existsSync(RECENT_FILE)) {
      return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveRecent(list) {
  try {
    const dir = path.dirname(RECENT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {}
}

function addRecent(entry) {
  let list = loadRecent();
  list = list.filter(function (r) { return r.path !== entry.path; });
  entry.time = Date.now();
  list.unshift(entry);
  if (list.length > 10) list = list.slice(0, 10);
  saveRecent(list);
  if (mainWindow) {
    mainWindow.webContents.send('recent:updated', list);
  }
}

// ── Launch helpers ────────────────────────────────────────────────────────────
function launchApp(exePath, appDir, filePath) {
  if (!fs.existsSync(exePath) || !fs.existsSync(appDir)) {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'App not ready',
      'Could not find app files.\n\nEXE: ' + exePath + '\nDIR: ' + appDir
    );
    return;
  }
  const args = filePath ? [appDir, filePath] : [appDir];
  const child = spawn(exePath, args, {
    cwd: appDir,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

// ── Main window ───────────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    resizable: false,
    title: 'Jain Office Suite',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', function () { mainWindow.show(); });
  mainWindow.on('closed', function () { mainWindow = null; });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('recent:load', function () { return loadRecent(); });

ipcMain.on('launch:document', function (_e, filePath) {
  launchApp(DOC_EXE, DOC_DIR, filePath || null);
  if (filePath) addRecent({ name: path.basename(filePath), path: filePath, app: 'JainDocument' });
});

ipcMain.on('launch:sheet', function (_e, filePath) {
  launchApp(SHEET_EXE, SHEET_DIR, filePath || null);
  if (filePath) addRecent({ name: path.basename(filePath), path: filePath, app: 'JainSheet' });
});

ipcMain.on('recent:openFolder', function (_e, filePath) {
  shell.showItemInFolder(filePath);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(function () {
  // Check if launched with a file argument (double-click or "Open with" in Explorer)
  const fileArg = getFileArg();

  if (fileArg) {
    // A file was passed — route directly to the correct app, skip launcher UI
    if (DOC_EXTENSIONS.has(fileArg.ext)) {
      launchApp(DOC_EXE, DOC_DIR, fileArg.filePath);
      addRecent({ name: path.basename(fileArg.filePath), path: fileArg.filePath, app: 'JainDocument' });
    } else if (SHEET_EXTENSIONS.has(fileArg.ext)) {
      launchApp(SHEET_EXE, SHEET_DIR, fileArg.filePath);
      addRecent({ name: path.basename(fileArg.filePath), path: fileArg.filePath, app: 'JainSheet' });
    }
    // Quit launcher immediately — the child app is now running independently
    app.quit();
  } else {
    // No file argument — show the launcher UI as normal
    createWindow();
  }
});

app.on('window-all-closed', function () { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', function () { if (!mainWindow) createWindow(); });
