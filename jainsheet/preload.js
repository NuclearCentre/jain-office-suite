'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Renderer → Main ────────────────────────────────────────────────────────
  writeFile:      (args)           => ipcRenderer.send('write-file', args),
  triggerSaveAs:  ()               => ipcRenderer.send('trigger-saveas'),
  autoSaveData:   (filePath, content) => ipcRenderer.send('autosave-data', { filePath, content }),

  // ── Main → Renderer (menu events) ──────────────────────────────────────────
  onNew:          (cb) => ipcRenderer.on('menu-new',         ()        => cb()),
  onOpen:         (cb) => ipcRenderer.on('menu-open',        (_e, arg) => cb(arg)),
  onSave:         (cb) => ipcRenderer.on('menu-save',        ()        => cb()),
  onSaveAs:       (cb) => ipcRenderer.on('menu-saveas',      (_e, fp)  => cb(fp)),
  onExportCsv:    (cb) => ipcRenderer.on('menu-exportcsv',   (_e, fp)  => cb(fp)),
  onImportCsv:    (cb) => ipcRenderer.on('menu-importcsv',   (_e, arg) => cb(arg)),
  onWriteDone:    (cb) => ipcRenderer.on('write-file-done',  (_e, r)   => cb(r)),
  onUndo:         (cb) => ipcRenderer.on('menu-undo',        ()        => cb()),
  onRedo:         (cb) => ipcRenderer.on('menu-redo',        ()        => cb()),
  onZoomIn:       (cb) => ipcRenderer.on('menu-zoomin',      ()        => cb()),
  onZoomOut:      (cb) => ipcRenderer.on('menu-zoomout',     ()        => cb()),
  onZoomReset:    (cb) => ipcRenderer.on('menu-zoomreset',   ()        => cb()),
  onGridlines:    (cb) => ipcRenderer.on('menu-gridlines',   ()        => cb()),
  onDarkMode:     (cb) => ipcRenderer.on('menu-darkmode',    ()        => cb()),
  onSelectAll:    (cb) => ipcRenderer.on('menu-selectall',   ()        => cb()),
  onAddSheet:     (cb) => ipcRenderer.on('menu-addsheet',    ()        => cb()),
  onRenameSheet:  (cb) => ipcRenderer.on('menu-renamesheet', ()        => cb()),
  onDeleteSheet:  (cb) => ipcRenderer.on('menu-deletesheet', ()        => cb()),
  onDuplicateSheet:(cb)=> ipcRenderer.on('menu-duplicatesheet',()      => cb()),
  onShortcuts:    (cb) => ipcRenderer.on('menu-shortcuts',   ()        => cb()),
  onFindReplace:  (cb) => ipcRenderer.on('menu-findreplace', ()        => cb()),
  onAutoSave:     (cb) => ipcRenderer.on('menu-autosave',    ()        => cb()),

});
