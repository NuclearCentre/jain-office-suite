'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

// ─── Auto-updater ─────────────────────────────────────────────────────────────
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload         = false; // ask user before downloading
  autoUpdater.autoInstallOnAppQuit = true;  // install on next quit if downloaded
  autoUpdater.logger               = null;  // suppress console spam
} catch(e) {
  // electron-updater not available in dev — safe to ignore
}

let _manualUpdateCheck = false;

function initAutoUpdater() {
  if (!autoUpdater) return;

  autoUpdater.on('checking-for-update', () => {
    if (mainWindow) mainWindow.setTitle('JainDocument — Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    if (!mainWindow) return;
    mainWindow.setTitle('JainDocument');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `JainDocument ${info.version} is available.`,
      detail: `You are running v${app.getVersion()}.\n\nDownload the update now? It will install automatically when you close the app.`,
      buttons: ['Download Now', 'Remind Me Later'],
      defaultId: 0, cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate();
        if (mainWindow) mainWindow.setTitle('JainDocument — Downloading update...');
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (mainWindow) mainWindow.setTitle('JainDocument');
    if (_manualUpdateCheck && mainWindow) {
      _manualUpdateCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Up to Date',
        message: `JainDocument v${app.getVersion()} is the latest version.`,
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (!mainWindow) return;
    const pct = Math.round(progress.percent);
    mainWindow.setTitle(`JainDocument — Downloading update ${pct}%...`);
    mainWindow.setProgressBar(pct / 100);
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (!mainWindow) return;
    mainWindow.setTitle('JainDocument');
    mainWindow.setProgressBar(-1);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `JainDocument ${info.version} downloaded and ready to install.`,
      detail: 'Restart now to apply the update, or it will install automatically next time you close the app.',
      buttons: ['Restart & Install', 'Later'],
      defaultId: 0, cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        isModified = false;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    if (mainWindow) mainWindow.setTitle('JainDocument');
    if (_manualUpdateCheck && mainWindow) {
      _manualUpdateCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Update Check Failed',
        message: 'Could not check for updates.',
        detail: 'Please check your internet connection and try again.\n\n' + (err.message || ''),
        buttons: ['OK'],
      });
    }
  });

  // Silent check 4 seconds after launch
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch(e) {} }, 4000);
}

function checkForUpdatesManually() {
  if (!autoUpdater) {
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'Check for Updates',
      message: `JainDocument v${app.getVersion()}`,
      detail: 'Auto-updater is not available in development mode.\nBuild the app with npm run build-win to enable updates.',
      buttons: ['OK'],
    });
    return;
  }
  _manualUpdateCheck = true;
  try { autoUpdater.checkForUpdates(); } catch(e) {}
}

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow   = null;
let isModified   = false;
let currentFile  = null;

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
    list.unshift({ name: path.basename(filePath), path: filePath, app: 'JainDocument', time: Date.now() });
    if (list.length > 10) list = list.slice(0, 10);
    fs.writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {}
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    // Use titleBarOverlay instead of frame:false so Windows draws native
    // min/max/close buttons — this gives us native snap layout flyout (Bug fix)
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color:       '#1e4d8c',   // matches our ribbon/titlebar colour
      symbolColor: '#ffffff',   // white icons
      height: 34,               // matches our titlebar height
    },
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

// ─── Save / Load helpers ──────────────────────────────────────────────────────
async function getRendererHtml() {
  return await mainWindow.webContents.executeJavaScript(`
    (() => {
      const p      = document.getElementById('page');
      const header = document.getElementById('doc-header');
      const footer = document.getElementById('doc-footer');
      const hZone  = document.getElementById('header-zone');
      const fZone  = document.getElementById('footer-zone');
      const hasHeader = hZone && hZone.style.display !== 'none' && header && header.innerHTML.trim();
      const hasFooter = fZone && fZone.style.display !== 'none' && footer && footer.innerHTML.trim();
      let html = '';
      if (hasHeader) html += '<div class="doc-header-saved" style="border-bottom:1px solid #ccc;padding:6px 0;margin-bottom:12pt;font-size:10pt;color:#555">' + (header ? header.innerHTML : '') + '</div>';
      html += p ? p.innerHTML : '';
      if (hasFooter) html += '<div class="doc-footer-saved" style="border-top:1px solid #ccc;padding:6px 0;margin-top:12pt;font-size:10pt;color:#555">' + (footer ? footer.innerHTML : '') + '</div>';
      return html;
    })()
  `);
}

async function buildDocxFromHtml(html) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType, BorderStyle,
    AlignmentType, UnderlineType, ShadingType,
    ImageRun, convertInchesToTwip,
  } = require('docx');
  const { JSDOM } = require('jsdom');
  const dom  = new JSDOM(html);
  const body = dom.window.document.body;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  // Convert CSS colour string → docx hex (no #)
  function cssColorToHex(color) {
    if (!color) return undefined;
    if (color.startsWith('#')) return color.slice(1).toUpperCase();
    const m = color.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) return [m[1],m[2],m[3]].map(n => parseInt(n).toString(16).padStart(2,'0')).join('').toUpperCase();
    return undefined;
  }

  // Convert pt/px font-size → half-points (docx unit)
  function cssToHalfPt(size) {
    if (!size) return undefined;
    const val = parseFloat(size);
    if (isNaN(val)) return undefined;
    if (size.includes('pt')) return Math.round(val * 2);
    if (size.includes('px')) return Math.round(val * 0.75 * 2);
    return undefined;
  }

  // Convert CSS alignment → docx AlignmentType
  function cssAlign(align) {
    if (!align) return undefined;
    const map = { left: AlignmentType.LEFT, center: AlignmentType.CENTER,
                  right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };
    return map[align.toLowerCase()] || undefined;
  }

  // Build TextRun options from an element's computed tag + inline style
  function runOpts(el, inheritStyle) {
    const tag   = (el.tagName || '').toLowerCase();
    const style = el.style || {};
    const inh   = inheritStyle || {};

    const bold      = ['b','strong'].includes(tag) || style.fontWeight === 'bold'
                      || style.fontWeight === '700' || inh.bold;
    const italics   = ['i','em'].includes(tag) || style.fontStyle === 'italic' || inh.italics;
    const strike    = ['s','strike','del'].includes(tag)
                      || style.textDecoration?.includes('line-through') || inh.strike;
    const underline = tag === 'u' || style.textDecoration?.includes('underline') || inh.underline
                      ? { type: UnderlineType.SINGLE } : undefined;
    const sup       = tag === 'sup' || inh.sup;
    const sub       = tag === 'sub' || inh.sub;
    const color     = cssColorToHex(style.color) || inh.color;
    const highlight = cssColorToHex(style.backgroundColor) || inh.highlight;
    const font      = style.fontFamily?.replace(/['"]/g,'').split(',')[0].trim() || inh.font;
    const size      = cssToHalfPt(style.fontSize) || inh.size;

    return { bold, italics, strike, underline, superScript: sup || undefined,
             subScript: sub || undefined, color, font: font ? { name: font } : undefined,
             size, highlight: highlight ? { color: highlight, type: ShadingType.CLEAR } : undefined };
  }

  // Recursively extract TextRuns from an inline element tree
  function extractRuns(node, inh) {
    const runs = [];
    node.childNodes.forEach(child => {
      if (child.nodeType === 3) {
        const t = child.textContent;
        if (t) {
          const opts = { text: t, ...inh };
          // Clean undefined keys
          Object.keys(opts).forEach(k => opts[k] === undefined && delete opts[k]);
          runs.push(new TextRun(opts));
        }
      } else if (child.nodeType === 1) {
        const opts = runOpts(child, inh);
        // Merge inherited + this element's opts
        const merged = { ...inh };
        Object.entries(opts).forEach(([k,v]) => { if (v !== undefined) merged[k] = v; });
        runs.push(...extractRuns(child, merged));
      }
    });
    return runs;
  }

  // Build paragraph options from a block element's style
  function paraOpts(el) {
    const style = el?.style || {};
    return {
      alignment: cssAlign(style.textAlign),
      spacing: style.lineHeight
        ? { line: Math.round(parseFloat(style.lineHeight) * 240) } : undefined,
      indent: style.paddingLeft
        ? { left: Math.round(parseFloat(style.paddingLeft) * 15) } : undefined,
    };
  }

  // Build a docx Table from an HTML <table>
  function buildTable(tableEl) {
    const rows = Array.from(tableEl.querySelectorAll('tr'));
    const docxRows = rows.map(row => {
      const cells = Array.from(row.querySelectorAll('td, th'));
      const docxCells = cells.map(cell => {
        const isHeader = cell.tagName.toLowerCase() === 'th';
        const runs = extractRuns(cell, isHeader ? { bold: true } : {});
        return new TableCell({
          children: [new Paragraph({ children: runs.length ? runs : [new TextRun('')] })],
          shading: isHeader ? { type: ShadingType.CLEAR, color: '1E4D8C', fill: '1E4D8C' } : undefined,
        });
      });
      return new TableRow({ children: docxCells });
    });
    return new Table({
      rows: docxRows,
      width: { size: 100, type: WidthType.PERCENTAGE },
    });
  }

  // ── Walk top-level block nodes ───────────────────────────────────────────────
  const children = [];

  function processNode(node) {
    if (node.nodeType === 3) {
      const t = (node.textContent || '').trim();
      if (t) children.push(new Paragraph({ children: [new TextRun(t)] }));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();

    if (tag === 'table') {
      children.push(buildTable(node));
      return;
    }

    if (tag === 'ul') {
      node.querySelectorAll(':scope > li').forEach(li => {
        const runs = extractRuns(li, {});
        children.push(new Paragraph({
          children: runs.length ? runs : [new TextRun(li.textContent || '')],
          bullet: { level: 0 },
        }));
      });
      return;
    }

    if (tag === 'ol') {
      node.querySelectorAll(':scope > li').forEach((li, i) => {
        const runs = extractRuns(li, {});
        children.push(new Paragraph({
          children: runs.length ? runs : [new TextRun(li.textContent || '')],
          numbering: { reference: 'default-numbering', level: 0 },
        }));
      });
      return;
    }

    if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
      const level = parseInt(tag[1]);
      const headingMap = {
        1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4,
        5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
      };
      const runs = extractRuns(node, { bold: true });
      const opts = paraOpts(node);
      children.push(new Paragraph({
        heading: headingMap[level],
        children: runs.length ? runs : [new TextRun({ text: node.textContent || '', bold: true })],
        alignment: opts.alignment,
      }));
      return;
    }

    if (tag === 'blockquote') {
      const runs = extractRuns(node, { italics: true, color: '555555' });
      children.push(new Paragraph({
        children: runs.length ? runs : [new TextRun('')],
        indent: { left: convertInchesToTwip(0.5) },
      }));
      return;
    }

    if (tag === 'pre') {
      const text = node.textContent || '';
      text.split('\n').forEach(line => {
        children.push(new Paragraph({
          children: [new TextRun({ text: line, font: { name: 'Courier New' }, size: 20 })],
        }));
      });
      return;
    }

    if (tag === 'br') {
      children.push(new Paragraph({ children: [] }));
      return;
    }

    if (tag === 'hr') {
      children.push(new Paragraph({
        children: [new TextRun('')],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA' } },
      }));
      return;
    }

    if (tag === 'img') {
      // Embed base64 images
      try {
        const src = node.getAttribute('src') || '';
        if (src.startsWith('data:')) {
          const match = src.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const mime = match[1];
            const b64  = match[2];
            const buf  = Buffer.from(b64, 'base64');
            const typeMap = { 'image/png':'png', 'image/jpeg':'jpg', 'image/gif':'gif',
                              'image/webp':'png', 'image/bmp':'bmp' };
            const imgType = typeMap[mime] || 'png';
            children.push(new Paragraph({
              children: [new ImageRun({
                data: buf, type: imgType,
                transformation: { width: 400, height: 300 },
              })],
            }));
            return;
          }
        }
      } catch(e) {}
      return;
    }

    // Default: treat as paragraph (p, div, span, li at top level, etc.)
    const runs = extractRuns(node, {});
    const opts = paraOpts(node);
    const paraArgs = {
      children: runs.length ? runs : [new TextRun('')],
    };
    if (opts.alignment) paraArgs.alignment = opts.alignment;
    if (opts.spacing)   paraArgs.spacing   = opts.spacing;
    if (opts.indent)    paraArgs.indent    = opts.indent;
    children.push(new Paragraph(paraArgs));
  }

  body.childNodes.forEach(processNode);

  if (!children.length) children.push(new Paragraph({ children: [new TextRun('')] }));

  const doc = new Document({
    numbering: {
      config: [{
        reference: 'default-numbering',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT }],
      }],
    },
    sections: [{ properties: {}, children }],
  });
  return await Packer.toBuffer(doc);
}

async function saveToPath(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  try {
    if (ext === 'docx' || ext === 'doc') {
      const html = await getRendererHtml();
      const buf  = await buildDocxFromHtml(html);
      fs.writeFileSync(filePath, buf);
    } else if (ext === 'html') {
      const html = await getRendererHtml();
      const full = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Document</title></head><body>${html}</body></html>`;
      fs.writeFileSync(filePath, full, 'utf-8');
    } else {
      const html = await getRendererHtml();
      const { JSDOM } = require('jsdom');
      const txt = new JSDOM(html).window.document.body.textContent || '';
      fs.writeFileSync(filePath, txt, 'utf-8');
    }
    currentFile = filePath;
    isModified  = false;
    addToRecentSuite(filePath);
    mainWindow.webContents.send('document:saved', { filePath });
    mainWindow.setTitle(`JainDocument — ${path.basename(filePath)}`);
    return true;
  } catch (err) {
    dialog.showErrorBox('Save Error', err.message);
    return false;
  }
}

async function showSaveAsDialog() {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save As',
    defaultPath: currentFile || path.join(app.getPath('documents'), 'Document.docx'),
    filters: [
      { name: 'Word Document (.docx)',  extensions: ['docx'] },
      { name: 'Word Document (.doc)',   extensions: ['doc']  },
      { name: 'Web Page (.html)',       extensions: ['html'] },
      { name: 'Plain Text (.txt)',      extensions: ['txt']  },
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
    detail: "Your changes will be lost if you don't save them.",
  });
  if (response === 2) return false;
  if (response === 0) {
    let saved;
    if (currentFile) { saved = await saveToPath(currentFile); }
    else { const p = await showSaveAsDialog(); saved = p ? await saveToPath(p) : false; }
    if (!saved) return false;
  }
  if (action === 'close')  { isModified = false; mainWindow.destroy(); }
  if (action === 'new')    doNew();
  if (action === 'open')   doOpen();
  return true;
}

// ─── New / Open ───────────────────────────────────────────────────────────────
function doNew() {
  currentFile = null;
  isModified  = false;
  mainWindow.setTitle('JainDocument — Untitled');
  mainWindow.webContents.send('document:new');
}

async function doOpen() {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open File',
    filters: [
      { name: 'Supported Files', extensions: ['docx', 'html', 'htm', 'txt'] },
      { name: 'Word Documents',  extensions: ['docx'] },
      { name: 'Web Pages',       extensions: ['html', 'htm'] },
      { name: 'Text Files',      extensions: ['txt'] },
    ],
    properties: ['openFile'],
  });
  if (!filePaths || !filePaths[0]) return;
  await doOpenPath(filePaths[0]);
}

// Shared file-loading logic — used by doOpen and menu:openPath (Bug 2 fix)
async function doOpenPath(fp) {
  const ext = fp.split('.').pop().toLowerCase();
  try {
    if (ext === 'docx') {
      const mammoth = require('mammoth');

      // ── Full-fidelity style map ──────────────────────────────────────────
      const styleMap = [
        // Headings
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Heading 4'] => h4:fresh",
        "p[style-name='Heading 5'] => h5:fresh",
        "p[style-name='Heading 6'] => h6:fresh",
        // Common named styles
        "p[style-name='Title']     => h1.doc-title:fresh",
        "p[style-name='Subtitle']  => p.doc-subtitle:fresh",
        "p[style-name='Quote']     => blockquote:fresh",
        "p[style-name='Intense Quote'] => blockquote.intense:fresh",
        "p[style-name='Code']      => pre:fresh",
        // Lists
        "p[style-name='List Paragraph'] => p.list-paragraph:fresh",
        // Table styles
        "r[style-name='Strong']    => strong",
        "r[style-name='Emphasis']  => em",
        // Inline code
        "r[style-name='Code Char'] => code",
      ].join('\n');

      // ── Image converter — embed as base64 data URI ───────────────────────
      const imageConverter = mammoth.images.imgElement((image) => {
        return image.read('base64').then((imgData) => {
          return { src: `data:${image.contentType};base64,${imgData}` };
        });
      });

      const result = await mammoth.convertToHtml(
        { path: fp },
        {
          styleMap,
          convertImage: imageConverter,
          includeDefaultStyleMap: true,
          ignoreEmptyParagraphs: false,
        }
      );

      // ── Post-process: inject inline styles for fidelity ──────────────────
      let html = result.value;

      // Wrap tables with responsive container
      html = html.replace(/<table>/g,
        '<table style="border-collapse:collapse;width:100%;margin:8pt 0">');
      html = html.replace(/<td>/g,
        '<td style="border:1px solid #bbb;padding:4pt 8pt;min-width:40px">');
      html = html.replace(/<th>/g,
        '<th style="border:1px solid #bbb;padding:4pt 8pt;background:#1e4d8c;color:#fff;font-weight:bold">');

      // Ensure images are responsive
      html = html.replace(/<img /g,
        '<img style="max-width:100%;height:auto;display:block;margin:8pt auto" ');

      // Fix list styling
      html = html.replace(/<ul>/g,
        '<ul style="padding-left:28pt;margin:4pt 0">');
      html = html.replace(/<ol>/g,
        '<ol style="padding-left:28pt;margin:4pt 0">');
      html = html.replace(/<li>/g,
        '<li style="margin:2pt 0">');

      // Report any warnings to console (harmless GPU-type messages)
      if (result.messages && result.messages.length > 0) {
        const warnings = result.messages.filter(m => m.type === 'warning');
        if (warnings.length) console.log(`[Import] ${warnings.length} warning(s) from mammoth`);
      }

      mainWindow.webContents.send('document:open', { html, filePath: fp });

    } else if (ext === 'html' || ext === 'htm') {
      const raw   = fs.readFileSync(fp, 'utf-8');
      const match = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const html  = match ? match[1] : raw;
      mainWindow.webContents.send('document:open', { html, filePath: fp });
    } else {
      // Plain text — preserve line breaks and basic structure
      const text = fs.readFileSync(fp, 'utf-8');
      const html = text.split('\n').map(l => {
        const escaped = l
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return escaped ? `<p>${escaped}</p>` : '<p><br></p>';
      }).join('');
      mainWindow.webContents.send('document:open', { html, filePath: fp });
    }
    currentFile = fp;
    isModified  = false;
    addToRecentSuite(fp);
    mainWindow.setTitle(`JainDocument — ${path.basename(fp)}`);
  } catch (err) {
    dialog.showErrorBox('Open Error', err.message);
  }
}

// ─── Export to PDF ────────────────────────────────────────────────────────────
async function doExportPdf() {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export as PDF',
    defaultPath: currentFile
      ? currentFile.replace(/\.[^.]+$/, '.pdf')
      : path.join(app.getPath('documents'), 'Document.pdf'),
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  });
  if (!filePath) return;
  try {
    const data = await mainWindow.webContents.printToPDF({
      marginsType: 0, pageSize: 'A4', printBackground: true,
    });
    fs.writeFileSync(filePath, data);
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'Export Successful',
      message: 'PDF exported successfully.',
      detail: filePath,
      buttons: ['OK', 'Open File'],
    }).then(({ response }) => {
      if (response === 1) shell.openPath(filePath);
    });
  } catch (err) {
    dialog.showErrorBox('PDF Export Error', err.message);
  }
}

// ─── Backup ───────────────────────────────────────────────────────────────────
async function doBackup() {
  if (!currentFile) {
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'Backup',
      message: 'Please save your document first before creating a backup.',
      buttons: ['OK'],
    });
    return;
  }
  const backupPath = currentFile + '.bak';
  try {
    fs.copyFileSync(currentFile, backupPath);
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'Backup Created',
      message: 'Backup created successfully.',
      detail: backupPath,
      buttons: ['OK'],
    });
  } catch (err) {
    dialog.showErrorBox('Backup Error', err.message);
  }
}

// ─── Settings file ────────────────────────────────────────────────────────────
const settingsPath = path.join(app.getPath('userData'), 'jaindocument-settings.json');
function readSettings() {
  try {
    if (fs.existsSync(settingsPath)) return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {}
  return null;
}
function writeSettings(data) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8'); } catch {}
}
ipcMain.handle('settings:load', () => readSettings());
ipcMain.handle('settings:save', (_e, data) => { writeSettings(data); return true; });

// ─── IPC handlers ─────────────────────────────────────────────────────────────
// window:minimize / maximize / snap removed — titleBarOverlay handles natively
ipcMain.on('window:close', async () => {
  if (!isModified) { mainWindow.destroy(); return; }
  await promptSaveBeforeAction('close');
});

// Update native titleBarOverlay colour when user changes theme
ipcMain.on('titlebar:setColor', (_e, color) => {
  if (mainWindow && color) {
    mainWindow.setTitleBarOverlay({ color, symbolColor: '#ffffff', height: 34 });
  }
});

ipcMain.on('document:modified', () => {
  isModified = true;
  const base = currentFile ? path.basename(currentFile) : 'Untitled';
  mainWindow.setTitle(`● JainDocument — ${base}`);
});
ipcMain.on('document:clean', () => { isModified = false; });

ipcMain.on('menu:new',    async () => { if (isModified) await promptSaveBeforeAction('new');  else doNew();  });
ipcMain.on('menu:open',   async () => { if (isModified) await promptSaveBeforeAction('open'); else doOpen(); });
ipcMain.on('menu:openPath', async (_e, fp) => {
  // Bug 2 fix — open a specific file directly (used by Recent Files)
  if (!fp) return;
  if (!require('fs').existsSync(fp)) {
    dialog.showErrorBox('File Not Found', `The file no longer exists:\n${fp}`);
    return;
  }
  if (isModified) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0, cancelId: 2,
      title: 'Unsaved Changes',
      message: 'Do you want to save your changes before opening another file?',
    });
    if (response === 2) return;
    if (response === 0) {
      if (currentFile) await saveToPath(currentFile);
      else { const p = await showSaveAsDialog(); if (p) await saveToPath(p); else return; }
    }
  }
  await doOpenPath(fp);
});
ipcMain.on('menu:save',   async () => {
  if (currentFile) await saveToPath(currentFile);
  else { const p = await showSaveAsDialog(); if (p) await saveToPath(p); }
});
ipcMain.on('menu:saveAs', async (_e, preferExt) => {
  const p = await showSaveAsDialog(preferExt);
  if (p) await saveToPath(p);
});
ipcMain.on('menu:saveToPath', async (_e, filePath) => {
  // Bug 17 fix — save directly to a specific path (used when closing a non-active tab)
  if (filePath) await saveToPath(filePath);
  else { const p = await showSaveAsDialog(); if (p) await saveToPath(p); }
});
ipcMain.on('menu:print',        () => mainWindow.webContents.print());
ipcMain.on('menu:exit',         async () => { if (!isModified) { mainWindow.destroy(); return; } await promptSaveBeforeAction('close'); });
ipcMain.on('menu:exportPdf',    () => doExportPdf());
ipcMain.on('menu:backup',       () => doBackup());
ipcMain.on('menu:checkUpdates', () => checkForUpdatesManually());
ipcMain.on('menu:email',        () => {
  const subject = encodeURIComponent(currentFile ? path.basename(currentFile) : 'JainDocument Document');
  shell.openExternal(`mailto:?subject=${subject}&body=Please%20find%20the%20attached%20document.`);
});
ipcMain.on('menu:about', () => {
  dialog.showMessageBox(mainWindow, {
    type: 'info', title: 'About JainDocument',
    message: `JainDocument v${app.getVersion()}`,
    detail: 'A full-featured word processor.\n\nSave as: .docx  .doc  .html  .txt\nOpen:    .docx  .html  .txt\n\nDeveloped with Electron.',
    buttons: ['OK'],
  });
});

ipcMain.handle('dialog:openCsv', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open CSV File for Mail Merge',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (!filePaths || !filePaths[0]) return null;
  try {
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    return { content, fileName: require('path').basename(filePaths[0]) };
  } catch(e) {
    return null;
  }
});

ipcMain.handle('dialog:insertImage', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Insert Image',
    filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','bmp','webp','svg'] }],
    properties: ['openFile'],
  });
  if (!filePaths || !filePaths[0]) return null;
  const data = fs.readFileSync(filePaths[0]);
  const ext  = filePaths[0].split('.').pop().toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return `data:${mime};base64,${data.toString('base64')}`;
});

// ─── Application menu ─────────────────────────────────────────────────────────
const menuTemplate = [
  { label: 'File', submenu: [
    { label: 'New',           accelerator: 'CmdOrCtrl+N',       click: () => ipcMain.emit('menu:new')    },
    { label: 'Open...',       accelerator: 'CmdOrCtrl+O',       click: () => ipcMain.emit('menu:open')   },
    { type: 'separator' },
    { label: 'Save',          accelerator: 'CmdOrCtrl+S',       click: () => ipcMain.emit('menu:save')   },
    { label: 'Save As...',    accelerator: 'CmdOrCtrl+Shift+S', click: () => ipcMain.emit('menu:saveAs') },
    { type: 'separator' },
    { label: 'Export as PDF', click: () => ipcMain.emit('menu:exportPdf') },
    { type: 'separator' },
    { label: 'Print...',      accelerator: 'CmdOrCtrl+P',       click: () => ipcMain.emit('menu:print')  },
    { type: 'separator' },
    { label: 'Exit',          accelerator: 'Alt+F4',            click: () => ipcMain.emit('menu:exit')   },
  ]},
  { label: 'Edit', submenu: [
    { label: 'Undo', role: 'undo' }, { label: 'Redo', role: 'redo' },
    { type: 'separator' },
    { label: 'Cut',  role: 'cut' }, { label: 'Copy', role: 'copy' },
    { label: 'Paste', role: 'paste' }, { label: 'Select All', role: 'selectAll' },
    { type: 'separator' },
    { label: 'Find...',           accelerator: 'CmdOrCtrl+F', click: () => mainWindow.webContents.send('ui:find')        },
    { label: 'Find & Replace...', accelerator: 'CmdOrCtrl+H', click: () => mainWindow.webContents.send('ui:findReplace') },
  ]},
  { label: 'View', submenu: [
    { label: 'Zoom In',    accelerator: 'CmdOrCtrl+=', click: () => mainWindow.webContents.send('view:zoomIn')    },
    { label: 'Zoom Out',   accelerator: 'CmdOrCtrl+-', click: () => mainWindow.webContents.send('view:zoomOut')   },
    { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.send('view:zoomReset') },
    { type: 'separator' },
    { label: 'Toggle Ruler', click: () => mainWindow.webContents.send('view:toggleRuler') },
    { label: 'Full Screen',  accelerator: 'F11', role: 'togglefullscreen' },
    { type: 'separator' },
    { label: 'Developer Tools', accelerator: 'F12', click: () => mainWindow.webContents.openDevTools() },
  ]},
  { label: 'Help', submenu: [
    { label: 'About JainDocument', click: () => ipcMain.emit('menu:about')        },
    { label: 'Check for Updates', click: () => ipcMain.emit('menu:checkUpdates') },
  ]},
];

// ─── Boot ─────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  createWindow();
  initAutoUpdater();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
