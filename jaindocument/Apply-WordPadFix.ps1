# ============================================================
# WordPad Pro — Auto Fix Script
# Run this in PowerShell as Administrator
# It will download all fixed files and rebuild automatically
# ============================================================

$ProjectRoot = "D:\Jain Word Project\wordpad-pro-source\wordpad-app"

# Verify project folder exists
if (-not (Test-Path $ProjectRoot)) {
    Write-Host "ERROR: Project folder not found at $ProjectRoot" -ForegroundColor Red
    Write-Host "Please update the path at the top of this script." -ForegroundColor Yellow
    pause
    exit
}

Set-Location $ProjectRoot
Write-Host "Working in: $ProjectRoot" -ForegroundColor Cyan

# ── Write main.js ─────────────────────────────────────────────────────────────
Write-Host "`nWriting main.js..." -ForegroundColor Yellow
@'
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow  = null;
let isModified  = false;
let currentFile = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 900,
    frame: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('close', async (e) => {
    if (!isModified) return;
    e.preventDefault();
    await promptSaveBeforeAction('close');
  });
}

async function getRendererHtml() {
  return await mainWindow.webContents.executeJavaScript(`
    (() => { const p = document.getElementById('page'); return p ? p.innerHTML : ''; })()`
  );
}

async function buildDocxFromHtml(html) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const { JSDOM } = require('jsdom');
  const dom  = new JSDOM(html);
  const body = dom.window.document.body;
  const children = [];
  body.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      const t = (node.textContent || '').trim();
      if (t) children.push(new Paragraph({ children: [new TextRun(t)] }));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag  = node.tagName.toLowerCase();
    const text = node.textContent || '';
    if (tag === 'h1') { children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1 })); }
    else if (tag === 'h2') { children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2 })); }
    else if (tag === 'h3') { children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_3 })); }
    else if (tag === 'ul') { node.querySelectorAll('li').forEach((li) => { children.push(new Paragraph({ text: li.textContent || '', bullet: { level: 0 } })); }); }
    else if (tag === 'br') { children.push(new Paragraph({ children: [] })); }
    else {
      const runs = [];
      node.childNodes.forEach((child) => {
        if (child.nodeType === 3) { const t = child.textContent || ''; if (t) runs.push(new TextRun(t)); }
        else if (child.nodeType === 1) {
          const ct = child.tagName.toLowerCase();
          runs.push(new TextRun({ text: child.textContent || '', bold: ['b','strong'].includes(ct), italics: ['i','em'].includes(ct), strike: ['s','strike','del'].includes(ct), underline: ct === 'u' }));
        }
      });
      children.push(new Paragraph({ children: runs.length ? runs : [new TextRun(text)] }));
    }
  });
  if (!children.length) children.push(new Paragraph({ children: [new TextRun('')] }));
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return await Packer.toBuffer(doc);
}

async function saveToPath(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  try {
    if (ext === 'docx' || ext === 'doc' || ext === 'wpdoc') {
      const html = await getRendererHtml();
      const buf  = await buildDocxFromHtml(html);
      fs.writeFileSync(filePath, buf);
    } else if (ext === 'html') {
      const html = await getRendererHtml();
      fs.writeFileSync(filePath, `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`, 'utf-8');
    } else {
      const html = await getRendererHtml();
      const { JSDOM } = require('jsdom');
      fs.writeFileSync(filePath, new JSDOM(html).window.document.body.textContent || '', 'utf-8');
    }
    currentFile = filePath;
    isModified  = false;
    mainWindow.webContents.send('document:saved', { filePath });
    mainWindow.setTitle('WordPad Pro — ' + path.basename(filePath));
    return true;
  } catch (err) {
    dialog.showErrorBox('Save Error', err.message);
    return false;
  }
}

async function showSaveAsDialog() {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save As',
    defaultPath: currentFile || path.join(app.getPath('documents'), 'Document.wpdoc'),
    filters: [
      { name: 'WordPad Pro Document (.wpdoc)', extensions: ['wpdoc'] },
      { name: 'Word Document (.docx)',          extensions: ['docx'] },
      { name: 'Word 97-2003 (.doc)',            extensions: ['doc']  },
      { name: 'Web Page (.html)',               extensions: ['html'] },
      { name: 'Plain Text (.txt)',              extensions: ['txt']  },
    ],
  });
  return filePath || null;
}

async function promptSaveBeforeAction(action) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0, cancelId: 2,
    title: 'Unsaved Changes',
    message: 'Do you want to save your changes?',
    detail: 'Your changes will be lost if you don\'t save them.',
  });
  if (response === 2) return false;
  if (response === 0) {
    const saved = currentFile ? await saveToPath(currentFile) : (async () => { const p = await showSaveAsDialog(); return p ? saveToPath(p) : false; })();
    if (!(await saved)) return false;
  }
  if (action === 'close') { isModified = false; mainWindow.destroy(); }
  if (action === 'new')   doNew();
  if (action === 'open')  doOpen();
  return true;
}

function doNew() {
  currentFile = null; isModified = false;
  mainWindow.setTitle('WordPad Pro — Untitled');
  mainWindow.webContents.send('document:new');
}

async function doOpen() {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open File',
    filters: [
      { name: 'All Supported', extensions: ['wpdoc','docx','html','htm','txt'] },
      { name: 'WordPad Pro Document', extensions: ['wpdoc'] },
      { name: 'Word Documents', extensions: ['docx'] },
      { name: 'Web Pages', extensions: ['html','htm'] },
      { name: 'Text Files', extensions: ['txt'] },
    ],
    properties: ['openFile'],
  });
  if (!filePaths || !filePaths[0]) return;
  const fp  = filePaths[0];
  const ext = fp.split('.').pop().toLowerCase();
  try {
    let html = '';
    if (ext === 'docx' || ext === 'wpdoc') {
      const mammoth = require('mammoth');
      const result  = await mammoth.convertToHtml({ path: fp });
      html = result.value;
    } else if (ext === 'html' || ext === 'htm') {
      const raw   = fs.readFileSync(fp, 'utf-8');
      const match = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      html = match ? match[1] : raw;
    } else {
      const text = fs.readFileSync(fp, 'utf-8');
      html = text.split('\n').map(l => `<p>${l.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>`).join('');
    }
    mainWindow.webContents.send('document:open', { html, filePath: fp });
    currentFile = fp; isModified = false;
    mainWindow.setTitle('WordPad Pro — ' + path.basename(fp));
  } catch (err) { dialog.showErrorBox('Open Error', err.message); }
}

ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window:close',    async () => { if (!isModified) { mainWindow.destroy(); return; } await promptSaveBeforeAction('close'); });
ipcMain.on('document:modified', () => { isModified = true; mainWindow.setTitle('● WordPad Pro — ' + (currentFile ? path.basename(currentFile) : 'Untitled')); });
ipcMain.on('document:clean',    () => { isModified = false; });
ipcMain.on('menu:new',    async () => { if (isModified) await promptSaveBeforeAction('new');  else doNew(); });
ipcMain.on('menu:open',   async () => { if (isModified) await promptSaveBeforeAction('open'); else doOpen(); });
ipcMain.on('menu:save',   async () => { if (currentFile) await saveToPath(currentFile); else { const p = await showSaveAsDialog(); if (p) await saveToPath(p); } });
ipcMain.on('menu:saveAs', async () => { const p = await showSaveAsDialog(); if (p) await saveToPath(p); });
ipcMain.on('menu:print',  () => mainWindow.webContents.print());
ipcMain.on('menu:exit',   async () => { if (!isModified) { mainWindow.destroy(); return; } await promptSaveBeforeAction('close'); });
ipcMain.handle('dialog:insertImage', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Insert Image', filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','bmp','webp','svg'] }], properties: ['openFile'] });
  if (!filePaths || !filePaths[0]) return null;
  const data = fs.readFileSync(filePaths[0]);
  const ext  = filePaths[0].split('.').pop().toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return `data:${mime};base64,${data.toString('base64')}`;
});

const menuTemplate = [
  { label: 'File', submenu: [
    { label: 'New',        accelerator: 'CmdOrCtrl+N', click: () => ipcMain.emit('menu:new') },
    { label: 'Open...',    accelerator: 'CmdOrCtrl+O', click: () => ipcMain.emit('menu:open') },
    { type: 'separator' },
    { label: 'Save',       accelerator: 'CmdOrCtrl+S', click: () => ipcMain.emit('menu:save') },
    { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', click: () => ipcMain.emit('menu:saveAs') },
    { type: 'separator' },
    { label: 'Print...',   accelerator: 'CmdOrCtrl+P', click: () => ipcMain.emit('menu:print') },
    { type: 'separator' },
    { label: 'Exit', click: () => ipcMain.emit('menu:exit') },
  ]},
  { label: 'Edit', submenu: [
    { label: 'Undo', role: 'undo' }, { label: 'Redo', role: 'redo' }, { type: 'separator' },
    { label: 'Cut', role: 'cut' }, { label: 'Copy', role: 'copy' }, { label: 'Paste', role: 'paste' }, { label: 'Select All', role: 'selectAll' }, { type: 'separator' },
    { label: 'Find...',           accelerator: 'CmdOrCtrl+F', click: () => mainWindow.webContents.send('ui:find') },
    { label: 'Find & Replace...', accelerator: 'CmdOrCtrl+H', click: () => mainWindow.webContents.send('ui:findReplace') },
  ]},
  { label: 'View', submenu: [
    { label: 'Zoom In',    accelerator: 'CmdOrCtrl+=', click: () => mainWindow.webContents.send('view:zoomIn') },
    { label: 'Zoom Out',   accelerator: 'CmdOrCtrl+-', click: () => mainWindow.webContents.send('view:zoomOut') },
    { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.send('view:zoomReset') },
    { type: 'separator' },
    { label: 'Toggle Ruler', click: () => mainWindow.webContents.send('view:toggleRuler') },
    { label: 'Full Screen',  accelerator: 'F11', role: 'togglefullscreen' },
    { type: 'separator' },
    { label: 'Developer Tools', accelerator: 'F12', click: () => mainWindow.webContents.openDevTools() },
  ]},
  { label: 'Help', submenu: [
    { label: 'About WordPad Pro', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: 'About WordPad Pro', message: 'WordPad Pro v1.0.0', detail: 'Save as: .wpdoc  .docx  .doc  .html  .txt\nOpen:    .wpdoc  .docx  .html  .txt' }) },
  ]},
];

app.whenReady().then(() => { Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate)); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
'@ | Set-Content -Path "$ProjectRoot\main.js" -Encoding UTF8

Write-Host "  main.js written" -ForegroundColor Green

# ── Write preload.js ──────────────────────────────────────────────────────────
Write-Host "Writing preload.js..." -ForegroundColor Yellow
@'
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  minimize:     () => ipcRenderer.send('window:minimize'),
  maximize:     () => ipcRenderer.send('window:maximize'),
  close:        () => ipcRenderer.send('window:close'),
  menuNew:      () => ipcRenderer.send('menu:new'),
  menuOpen:     () => ipcRenderer.send('menu:open'),
  menuSave:     () => ipcRenderer.send('menu:save'),
  menuSaveAs:   () => ipcRenderer.send('menu:saveAs'),
  menuPrint:    () => ipcRenderer.send('menu:print'),
  menuExit:     () => ipcRenderer.send('menu:exit'),
  markModified: () => ipcRenderer.send('document:modified'),
  markClean:    () => ipcRenderer.send('document:clean'),
  insertImage:  () => ipcRenderer.invoke('dialog:insertImage'),
  onNew:          (cb) => ipcRenderer.on('document:new',        () => cb()),
  onOpen:         (cb) => ipcRenderer.on('document:open',       (_e, d) => cb(d)),
  onSaved:        (cb) => ipcRenderer.on('document:saved',      (_e, d) => cb(d)),
  onPrint:        (cb) => ipcRenderer.on('document:print',      () => cb()),
  onFind:         (cb) => ipcRenderer.on('ui:find',             () => cb()),
  onFindReplace:  (cb) => ipcRenderer.on('ui:findReplace',      () => cb()),
  onZoomIn:       (cb) => ipcRenderer.on('view:zoomIn',         () => cb()),
  onZoomOut:      (cb) => ipcRenderer.on('view:zoomOut',        () => cb()),
  onZoomReset:    (cb) => ipcRenderer.on('view:zoomReset',      () => cb()),
  onRulerToggle:  (cb) => ipcRenderer.on('view:toggleRuler',    () => cb()),
});
'@ | Set-Content -Path "$ProjectRoot\preload.js" -Encoding UTF8

Write-Host "  preload.js written" -ForegroundColor Green

# ── Write src\app.js ──────────────────────────────────────────────────────────
Write-Host "Writing src\app.js..." -ForegroundColor Yellow
@'
'use strict';
const page = () => document.getElementById('page');
function execCmd(cmd, val = null) { document.execCommand(cmd, false, val); page().focus(); }

let _modified = false;
function markModified() { if (!_modified) { _modified = true; window.electronAPI.markModified(); } }
function markClean()    { _modified = false; window.electronAPI.markClean(); }

function updatePlaceholder() {
  const p = page(); if (!p) return;
  p.classList.toggle('placeholder', p.innerHTML.replace(/<br\s*\/?>/gi,'').trim() === '');
}

function updateStatus() {
  const p = page(); if (!p) return;
  const text  = p.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const wc = document.getElementById('wordCount'); if (wc) wc.textContent = 'Words: ' + words;
  const cc = document.getElementById('charCount'); if (cc) cc.textContent = 'Chars: ' + text.length;
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(p); r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    const lines = r.toString().split('\n');
    const pos = document.getElementById('cursorPos'); if (pos) pos.textContent = 'Ln ' + lines.length + ', Col ' + (lines[lines.length-1].length+1);
  }
}

function flashSaved() {
  const b = document.getElementById('saveStatus'); if (!b) return;
  b.textContent = '✔ Saved'; b.style.color = '#28a745';
  setTimeout(() => { b.textContent = ''; }, 2000);
}

let zoomLevel = 100;
function setZoom(z) {
  zoomLevel = Math.min(200, Math.max(50, z));
  const p = page(); if (p) p.style.transform = 'scale(' + (zoomLevel/100) + ')';
  const zd = document.getElementById('zoomDisplay'); if (zd) zd.textContent = zoomLevel + '%';
  const zs = document.getElementById('zoomSlider');  if (zs) zs.value = zoomLevel;
}

function btn(id, fn) { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); }

function insertTable(rows, cols) {
  let html = '<table border="1" style="border-collapse:collapse;width:100%">';
  for (let r=0;r<rows;r++) { html+='<tr>'; for(let c=0;c<cols;c++) html+='<td style="padding:4px;min-width:60px">&nbsp;</td>'; html+='</tr>'; }
  html += '</table><p><br></p>'; execCmd('insertHTML', html); markModified();
}
function insertChar(ch) { execCmd('insertText', ch); markModified(); }
function insertDateTime() { execCmd('insertText', new Date().toLocaleString()); markModified(); }

function openFindBar()  { const b=document.getElementById('findBar'); if(b){b.style.display='flex'; document.getElementById('findInput')?.focus();} }
function closeFindBar() { const b=document.getElementById('findBar'); if(b) b.style.display='none'; }
function doFind()       { const t=document.getElementById('findInput')?.value; if(t) window.find(t,false,false,true); }
function doReplace()    { const f=document.getElementById('findInput')?.value; const r=document.getElementById('replaceInput')?.value||''; if(!f) return; const p=page(); p.innerHTML=p.innerHTML.split(f).join(r); markModified(); }

let spellOn = true;
function toggleSpell() { spellOn=!spellOn; const p=page(); if(p) p.spellcheck=spellOn; const s=document.getElementById('spellStatus'); if(s) s.textContent='Spell: '+(spellOn?'ON':'OFF'); }

function applyStyle(tag) { execCmd('formatBlock', tag); markModified(); }
function setLineSpacing(val) { const sel=window.getSelection(); if(!sel.rangeCount) return; let n=sel.getRangeAt(0).commonAncestorContainer; while(n&&n.nodeType!==1) n=n.parentNode; if(n) n.style.lineHeight=val; markModified(); }
function setColumns(n) { const p=page(); if(!p) return; p.style.columnCount=n>1?n:''; p.style.columnGap=n>1?'2em':''; markModified(); }
function setPageSize(w,h) { const p=page(); if(!p) return; p.style.width=w; p.style.minHeight=h; }
function setMargins(t,r,b,l) { const p=page(); if(!p) return; p.style.padding=t+' '+r+' '+b+' '+l; }
function setOrientation(o) { o==='landscape'?setPageSize('27.7cm','19.05cm'):setPageSize('21cm','29.7cm'); }
function toggleRuler() { const r=document.getElementById('ruler'); if(r) r.style.display=r.style.display==='none'?'block':'none'; }
function toggleFullScreen() { !document.fullscreenElement?document.documentElement.requestFullscreen?.():document.exitFullscreen?.(); }
function toggleWordCountPanel() {
  const p=document.getElementById('wordCountPanel'); if(!p) return;
  if(p.style.display!=='none'){p.style.display='none';return;}
  const text=page()?.innerText||''; const w=text.trim()?text.trim().split(/\s+/).length:0;
  p.innerHTML='<b>Word Count</b><br>Words: '+w+'<br>Characters: '+text.length+'<br>Paragraphs: '+((text.match(/\n\n/g)||[]).length+1);
  p.style.display='block';
}

function initFontControls() {
  const fs=document.getElementById('fontFamily'); if(fs) fs.addEventListener('change',()=>{execCmd('fontName',fs.value);markModified();});
  const fz=document.getElementById('fontSize');   if(fz) fz.addEventListener('change',()=>{execCmd('fontSize',fz.value);markModified();});
}
function initColorPickers() {
  const fc=document.getElementById('fontColor');      if(fc) fc.addEventListener('input',()=>{execCmd('foreColor',fc.value);markModified();});
  const hc=document.getElementById('highlightColor'); if(hc) hc.addEventListener('input',()=>{execCmd('backColor',hc.value);markModified();});
}
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => {
    const t=b.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); document.getElementById('tab-'+t)?.classList.add('active');
  }));
}

async function insertImageFromFile() { const d=await window.electronAPI.insertImage(); if(!d) return; execCmd('insertHTML','<img src="'+d+'" style="max-width:100%;display:block;margin:8px 0">'); markModified(); }
function insertLink() { const u=prompt('Enter URL:','https://'); if(u){execCmd('createLink',u);markModified();} }

function highlightGrid(r,c) { document.querySelectorAll('.grid-cell').forEach(el=>el.classList.toggle('active',+el.dataset.r<=r&&+el.dataset.c<=c)); }
function hideTablePicker() { const p=document.getElementById('tablePicker'); if(p) p.style.display='none'; }

function wireButtons() {
  btn('btn-minimize', () => window.electronAPI.minimize());
  btn('btn-maximize', () => window.electronAPI.maximize());
  btn('btn-close',    () => window.electronAPI.close());
  btn('btn-new',      () => window.electronAPI.menuNew());
  btn('btn-open',     () => window.electronAPI.menuOpen());
  btn('btn-save',     () => window.electronAPI.menuSave());
  btn('btn-save-as',  () => window.electronAPI.menuSaveAs());
  btn('btn-print',    () => window.electronAPI.menuPrint());
  btn('btn-bold',          () => { execCmd('bold');          markModified(); });
  btn('btn-italic',        () => { execCmd('italic');        markModified(); });
  btn('btn-underline',     () => { execCmd('underline');     markModified(); });
  btn('btn-strike',        () => { execCmd('strikeThrough'); markModified(); });
  btn('btn-super',         () => { execCmd('superscript');   markModified(); });
  btn('btn-sub',           () => { execCmd('subscript');     markModified(); });
  btn('btn-clear-fmt',     () => { execCmd('removeFormat');  markModified(); });
  btn('btn-align-left',    () => { execCmd('justifyLeft');   markModified(); });
  btn('btn-align-center',  () => { execCmd('justifyCenter'); markModified(); });
  btn('btn-align-right',   () => { execCmd('justifyRight');  markModified(); });
  btn('btn-align-justify', () => { execCmd('justifyFull');   markModified(); });
  btn('btn-bullet',        () => { execCmd('insertUnorderedList'); markModified(); });
  btn('btn-numbered',      () => { execCmd('insertOrderedList');   markModified(); });
  btn('btn-indent',        () => { execCmd('indent');  markModified(); });
  btn('btn-outdent',       () => { execCmd('outdent'); markModified(); });
  btn('btn-h1',     () => applyStyle('h1'));
  btn('btn-h2',     () => applyStyle('h2'));
  btn('btn-h3',     () => applyStyle('h3'));
  btn('btn-h4',     () => applyStyle('h4'));
  btn('btn-normal', () => applyStyle('p'));
  btn('btn-quote',  () => applyStyle('blockquote'));
  btn('btn-code',   () => applyStyle('pre'));
  const ls=document.getElementById('lineSpacing'); if(ls) ls.addEventListener('change',()=>setLineSpacing(ls.value));
  btn('btn-find',         openFindBar);
  btn('btn-find-replace', openFindBar);
  btn('btn-find-next',    doFind);
  btn('btn-replace-all',  doReplace);
  btn('btn-find-close',   closeFindBar);
  btn('btn-select-all',   () => execCmd('selectAll'));
  btn('btn-image',        insertImageFromFile);
  btn('btn-link',         insertLink);
  btn('btn-hr',           () => { execCmd('insertHorizontalRule'); markModified(); });
  btn('btn-page-break',   () => { execCmd('insertHTML','<hr class="page-break">'); markModified(); });
  btn('btn-datetime',     insertDateTime);
  const grid=document.getElementById('tableGrid');
  if(grid) {
    for(let r=1;r<=5;r++) for(let c=1;c<=8;c++) {
      const cell=document.createElement('div'); cell.className='grid-cell'; cell.dataset.r=r; cell.dataset.c=c;
      cell.addEventListener('mouseenter',()=>highlightGrid(r,c));
      cell.addEventListener('click',()=>{insertTable(r,c);hideTablePicker();});
      grid.appendChild(cell);
    }
    grid.style.display='grid'; grid.style.gridTemplateColumns='repeat(8,20px)';
  }
  btn('btn-table',()=>{ const p=document.getElementById('tablePicker'); if(p) p.style.display=p.style.display==='none'?'block':'none'; });
  document.querySelectorAll('.special-char').forEach(el=>el.addEventListener('click',()=>insertChar(el.textContent)));
  btn('btn-margin-normal', ()=>setMargins('2.54cm','2.54cm','2.54cm','2.54cm'));
  btn('btn-margin-narrow', ()=>setMargins('1.27cm','1.27cm','1.27cm','1.27cm'));
  btn('btn-margin-wide',   ()=>setMargins('2.54cm','5.08cm','2.54cm','5.08cm'));
  btn('btn-portrait',      ()=>setOrientation('portrait'));
  btn('btn-landscape',     ()=>setOrientation('landscape'));
  btn('btn-size-a4',       ()=>setPageSize('21cm','29.7cm'));
  btn('btn-size-a3',       ()=>setPageSize('29.7cm','42cm'));
  btn('btn-size-a5',       ()=>setPageSize('14.8cm','21cm'));
  btn('btn-size-letter',   ()=>setPageSize('21.59cm','27.94cm'));
  btn('btn-col-1',         ()=>setColumns(1));
  btn('btn-col-2',         ()=>setColumns(2));
  btn('btn-col-3',         ()=>setColumns(3));
  btn('btn-spell-toggle',  toggleSpell);
  btn('btn-word-count',    toggleWordCountPanel);
  btn('btn-zoom-in',       ()=>setZoom(zoomLevel+10));
  btn('btn-zoom-out',      ()=>setZoom(zoomLevel-10));
  btn('btn-zoom-reset',    ()=>setZoom(100));
  btn('btn-ruler-toggle',  toggleRuler);
  btn('btn-fullscreen',    toggleFullScreen);
  const zs=document.getElementById('zoomSlider');  if(zs) zs.addEventListener('input',()=>setZoom(parseInt(zs.value)));
  btn('zoomMinus', ()=>setZoom(zoomLevel-10));
  btn('zoomPlus',  ()=>setZoom(zoomLevel+10));
}

function initPage() {
  const p=page(); if(!p) return;
  p.addEventListener('input',()=>{markModified();updatePlaceholder();updateStatus();});
  p.addEventListener('keyup',updateStatus); p.addEventListener('mouseup',updateStatus);
  p.addEventListener('focus',()=>{if(p.classList.contains('placeholder')){p.innerHTML='';p.classList.remove('placeholder');}});
  p.addEventListener('keydown',(e)=>{
    if(e.ctrlKey&&e.shiftKey&&e.key==='S'){e.preventDefault();window.electronAPI.menuSaveAs();return;}
    if(e.ctrlKey&&e.key==='s'){e.preventDefault();window.electronAPI.menuSave();return;}
    if(e.ctrlKey&&e.key==='n'){e.preventDefault();window.electronAPI.menuNew();return;}
    if(e.ctrlKey&&e.key==='o'){e.preventDefault();window.electronAPI.menuOpen();return;}
    if(e.ctrlKey&&e.key==='p'){e.preventDefault();window.electronAPI.menuPrint();return;}
    if(e.ctrlKey&&e.key==='f'){e.preventDefault();openFindBar();return;}
    if(e.ctrlKey&&e.key==='h'){e.preventDefault();openFindBar();return;}
    if(e.key==='Escape'){closeFindBar();return;}
  });
  updatePlaceholder();
}

function initIPC() {
  window.electronAPI.onNew(()=>{const p=page();if(p)p.innerHTML='';markClean();updatePlaceholder();updateStatus();});
  window.electronAPI.onOpen(({html})=>{const p=page();if(p)p.innerHTML=html;markClean();updatePlaceholder();updateStatus();});
  window.electronAPI.onSaved(()=>{markClean();flashSaved();});
  window.electronAPI.onPrint(()=>window.print());
  window.electronAPI.onFind(openFindBar);
  window.electronAPI.onFindReplace(openFindBar);
  window.electronAPI.onZoomIn(()=>setZoom(zoomLevel+10));
  window.electronAPI.onZoomOut(()=>setZoom(zoomLevel-10));
  window.electronAPI.onZoomReset(()=>setZoom(100));
  window.electronAPI.onRulerToggle(toggleRuler);
}

document.addEventListener('DOMContentLoaded',()=>{initTabs();wireButtons();initFontControls();initColorPickers();initPage();initIPC();updateStatus();});
'@ | Set-Content -Path "$ProjectRoot\src\app.js" -Encoding UTF8

Write-Host "  src\app.js written" -ForegroundColor Green

# ── Write package.json ────────────────────────────────────────────────────────
Write-Host "Writing package.json..." -ForegroundColor Yellow
@'
{
  "name": "wordpad-pro",
  "version": "1.0.0",
  "description": "WordPad Pro - Full Featured Word Processor",
  "author": "WordPad Pro",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build-win": "electron-builder --win --x64"
  },
  "build": {
    "appId": "com.wordpadpro.app",
    "productName": "WordPad Pro",
    "directories": { "output": "dist" },
    "win": {
      "target": [{ "target": "nsis", "arch": ["x64"] }],
      "icon": "assets/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "WordPad Pro",
      "installerIcon": "assets/icon.ico",
      "uninstallerIcon": "assets/icon.ico"
    },
    "fileAssociations": [
      {
        "ext": "wpdoc",
        "name": "WordPad Pro Document",
        "description": "WordPad Pro Document",
        "icon": "assets/icon.ico",
        "role": "Editor"
      }
    ],
    "files": [
      "main.js", "preload.js", "src/**/*", "assets/**/*",
      "node_modules/docx/**/*", "node_modules/mammoth/**/*", "node_modules/jsdom/**/*"
    ]
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.9.1"
  },
  "dependencies": {
    "docx": "^8.5.0",
    "mammoth": "^1.7.2",
    "jsdom": "^24.0.0",
    "electron-updater": "^6.1.7"
  }
}
'@ | Set-Content -Path "$ProjectRoot\package.json" -Encoding UTF8

Write-Host "  package.json written" -ForegroundColor Green

# ── Build ─────────────────────────────────────────────────────────────────────
Write-Host "`nBuilding installer..." -ForegroundColor Cyan
npm run build-win

if ($LASTEXITCODE -eq 0) {
  Write-Host "`n✔ BUILD SUCCESSFUL!" -ForegroundColor Green
  Write-Host "Installer is at: $ProjectRoot\dist\WordPad Pro Setup 1.0.0.exe" -ForegroundColor Cyan
  Write-Host "`nNext steps:" -ForegroundColor Yellow
  Write-Host "  1. Uninstall old WordPad Pro (Settings → Apps → WordPad Pro → Uninstall)"
  Write-Host "  2. Install: dist\WordPad Pro Setup 1.0.0.exe"
  Write-Host "  3. Save your documents as .wpdoc to get the WordPad Pro J icon"
} else {
  Write-Host "`n✘ Build failed. Check the error above." -ForegroundColor Red
}

Write-Host "`nPress any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
