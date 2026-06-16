'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Renderer → Main ────────────────────────────────────────────────────────

  // Launch JainDocument (optionally with a file path)
  launchDocument:    (filePath) => ipcRenderer.send('launch:document', filePath || null),

  // Launch JainSheet (optionally with a file path)
  launchSheet:       (filePath) => ipcRenderer.send('launch:sheet',    filePath || null),

  // Show a recent file in Windows Explorer
  openFolder:        (filePath) => ipcRenderer.send('recent:openFolder', filePath),

  // ── Renderer → Main (invoke) ───────────────────────────────────────────────

  // Load recent files list on startup
  loadRecent:        ()         => ipcRenderer.invoke('recent:load'),

  // ── Main → Renderer ────────────────────────────────────────────────────────

  // Receive live recent files updates when a new file is opened
  onRecentUpdated:   (cb)       => ipcRenderer.on('recent:updated', (_e, list) => cb(list)),

});
