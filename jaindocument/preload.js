'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls handled natively by Windows titleBarOverlay
  // (minimize, maximize, close, snap are all native now)

  // File menu triggers
  menuNew:          () => ipcRenderer.send('menu:new'),
  menuOpen:         () => ipcRenderer.send('menu:open'),
  menuOpenPath:     (fp) => ipcRenderer.send('menu:openPath', fp),
  menuSave:         () => ipcRenderer.send('menu:save'),
  menuSaveAs:       (ext) => ipcRenderer.send('menu:saveAs', ext),
  menuSaveToPath:   (filePath) => ipcRenderer.send('menu:saveToPath', filePath),
  menuPrint:        () => ipcRenderer.send('menu:print'),
  menuExit:         () => ipcRenderer.send('menu:exit'),
  menuExportPdf:    () => ipcRenderer.send('menu:exportPdf'),
  menuEmail:        () => ipcRenderer.send('menu:email'),
  menuBackup:       () => ipcRenderer.send('menu:backup'),
  menuAbout:        () => ipcRenderer.send('menu:about'),
  menuCheckUpdates: () => ipcRenderer.send('menu:checkUpdates'),

  // Document state → main
  markModified: () => ipcRenderer.send('document:modified'),
  markClean:    () => ipcRenderer.send('document:clean'),
  setTitleBarColor: (color) => ipcRenderer.send('titlebar:setColor', color),

  // Settings (Fix 6: file-based, not localStorage)
  loadSettings: ()      => ipcRenderer.invoke('settings:load'),
  saveSettings: (data)  => ipcRenderer.invoke('settings:save', data),

  // Mail Merge
  openCsv: () => ipcRenderer.invoke('dialog:openCsv'),

  // Insert image (returns base64 data-URI or null)
  insertImage: () => ipcRenderer.invoke('dialog:insertImage'),

  // Events from main → renderer
  onNew:         (cb) => ipcRenderer.on('document:new',      () => cb()),
  onOpen:        (cb) => ipcRenderer.on('document:open',     (_e, data) => cb(data)),
  onSaved:       (cb) => ipcRenderer.on('document:saved',    (_e, data) => cb(data)),
  onPrint:       (cb) => ipcRenderer.on('document:print',    () => cb()),
  onFind:        (cb) => ipcRenderer.on('ui:find',           () => cb()),
  onFindReplace: (cb) => ipcRenderer.on('ui:findReplace',    () => cb()),
  onZoomIn:      (cb) => ipcRenderer.on('view:zoomIn',       () => cb()),
  onZoomOut:     (cb) => ipcRenderer.on('view:zoomOut',      () => cb()),
  onZoomReset:   (cb) => ipcRenderer.on('view:zoomReset',    () => cb()),
  onRulerToggle: (cb) => ipcRenderer.on('view:toggleRuler',  () => cb()),
});
