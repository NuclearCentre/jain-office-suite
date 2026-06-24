'use strict';
const { ipcRenderer } = require('electron');

// contextIsolation:false — set window.electronAPI directly (no contextBridge)
window.electronAPI = {
  // Main → renderer
  onNew:            (cb) => ipcRenderer.on('menu-new',           ()        => cb()),
  onOpen:           (cb) => ipcRenderer.on('menu-open',          (_e, arg) => cb(arg)),
  onSave:           (cb) => ipcRenderer.on('menu-save',          ()        => cb()),
  onSaveAs:         (cb) => ipcRenderer.on('menu-saveas',        (_e, fp)  => cb(fp)),
  onAutoSave:       (cb) => ipcRenderer.on('menu-autosave',      ()        => cb()),
  onImportCsv:      (cb) => ipcRenderer.on('menu-importcsv',     (_e, arg) => cb(arg)),
  onExportCsv:      (cb) => ipcRenderer.on('menu-exportcsv',     (_e, fp)  => cb(fp)),
  onUndo:           (cb) => ipcRenderer.on('menu-undo',          ()        => cb()),
  onRedo:           (cb) => ipcRenderer.on('menu-redo',          ()        => cb()),
  onSelectAll:      (cb) => ipcRenderer.on('menu-selectall',     ()        => cb()),
  onFindReplace:    (cb) => ipcRenderer.on('menu-findreplace',   ()        => cb()),
  onZoomIn:         (cb) => ipcRenderer.on('menu-zoomin',        ()        => cb()),
  onZoomOut:        (cb) => ipcRenderer.on('menu-zoomout',       ()        => cb()),
  onZoomReset:      (cb) => ipcRenderer.on('menu-zoomreset',     ()        => cb()),
  onGridlines:      (cb) => ipcRenderer.on('menu-gridlines',     ()        => cb()),
  onDarkMode:       (cb) => ipcRenderer.on('menu-darkmode',      ()        => cb()),
  onShortcuts:      (cb) => ipcRenderer.on('menu-shortcuts',     ()        => cb()),
  onAddSheet:       (cb) => ipcRenderer.on('menu-addsheet',      ()        => cb()),
  onRenameSheet:    (cb) => ipcRenderer.on('menu-renamesheet',   ()        => cb()),
  onDeleteSheet:    (cb) => ipcRenderer.on('menu-deletesheet',   ()        => cb()),
  onDuplicateSheet: (cb) => ipcRenderer.on('menu-duplicatesheet',()        => cb()),

  // Renderer → main
  menuNew:      ()              => ipcRenderer.send('menu-new'),
  writeFile:    (args)          => ipcRenderer.send('write-file',    args),
  triggerSaveAs:()              => ipcRenderer.send('trigger-saveas'),
  autoSaveData: (filePath, data)=> ipcRenderer.send('autosave-data', { filePath, content: data }),

  // Main → renderer: write-file result
  onWriteDone: (cb) => ipcRenderer.on('write-file-done', (_e, result) => cb(result)),
};
