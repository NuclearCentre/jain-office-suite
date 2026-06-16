'use strict';
/* ============================================================
   JainDocument — Renderer (app.js)  v1.1.0
   Features: Headers/Footers, Page Numbers, TOC, Table editing,
   Recent Files, Dark Mode, Reading Mode, Distraction-Free,
   Word Count Target, All original features preserved
   ============================================================ */

const page = () => document.getElementById('page');

function execCmd(cmd, val = null) {
  document.execCommand(cmd, false, val);
  page().focus();
}

// ─── Modified tracking ────────────────────────────────────────────────────────
let _modified = false;
function markModified() {
  if (!_modified) {
    _modified = true;
    window.electronAPI.markModified();
  }
  _updateActiveTab(true);
}
function markClean() {
  _modified = false;
  window.electronAPI.markClean();
  _updateActiveTab(false);
}

// ─── Placeholder ──────────────────────────────────────────────────────────────
function updatePlaceholder() {
  const p = page();
  if (!p) return;
  const empty = p.innerHTML.replace(/<br\s*\/?>/gi, '').trim() === '';
  p.classList.toggle('placeholder', empty);
}

// ─── Status bar ───────────────────────────────────────────────────────────────
function updateStatus() {
  const p = page();
  if (!p) return;
  const text  = p.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const wc = document.getElementById('wordCount');
  const cc = document.getElementById('charCount');
  if (wc) wc.textContent = `Words: ${words}`;
  if (cc) cc.textContent = `Chars: ${chars}`;
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    try {
      const range = sel.getRangeAt(0).cloneRange();
      range.selectNodeContents(p);
      range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
      const textBefore = range.toString();
      const lines = textBefore.split('\n');
      const ln = lines.length;
      const col = lines[lines.length - 1].length + 1;
      const pos = document.getElementById('cursorPos');
      if (pos) pos.textContent = `Ln ${ln}, Col ${col}`;
    } catch(e) {}
  }
  const pageCount = Math.max(1, Math.ceil(p.scrollHeight / 1123));
  const pc = document.getElementById('pageCount');
  if (pc) pc.textContent = `Page 1 of ${pageCount}`;
  const wrapper = document.getElementById('zoom-wrapper');
  if (wrapper) {
    const scale = zoomLevel / 100;
    wrapper.style.height = Math.round((p.scrollHeight + 60) * scale) + 'px';
  }
  updateWordTarget(words);
  updateDfStatus(words, chars);
  updatePageNumbers();
}

function flashSaved(msg) {
  const bar = document.getElementById('saveStatus');
  if (!bar) return;
  bar.textContent = msg || '✔ Saved';
  setTimeout(() => { bar.textContent = ''; }, 2500);
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
let zoomLevel = 100;
function setZoom(z) {
  zoomLevel = Math.min(200, Math.max(50, z));
  const p = page();
  if (p) p.style.transform = `scale(${zoomLevel / 100})`;
  ['zoomDisplay','zoomDisplay2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = zoomLevel + '%';
  });
  ['zoomSlider','zoomSlider2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = zoomLevel;
  });
  requestAnimationFrame(() => {
    const wrapper = document.getElementById('zoom-wrapper');
    if (wrapper && p) {
      const scale = zoomLevel / 100;
      wrapper.style.width  = Math.round((794 + 60) * scale) + 'px';
      wrapper.style.height = Math.round((p.scrollHeight + 60) * scale) + 'px';
    }
    // Resync ruler position after zoom
    if (_ruler.visible) { _rulerSync(); _rulerDraw(); }
  });
}

// ─── Font controls ────────────────────────────────────────────────────────────
let _pendingFontSize = null;
function initFontControls() {
  const fontSel = document.getElementById('fontFamily');
  if (fontSel) {
    fontSel.addEventListener('change', () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) execCmd('fontName', fontSel.value);
      else if (page()) page().style.fontFamily = fontSel.value;
      markModified();
    });
  }
  const sizeIn = document.getElementById('fontSize');
  if (sizeIn) {
    sizeIn.addEventListener('change', applyFontSize);
    sizeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyFontSize(); } });
  }
}

function applyFontSize() {
  const sizeIn = document.getElementById('fontSize');
  if (!sizeIn) return;
  const pt = parseFloat(sizeIn.value);
  if (!pt || pt < 1) return;
  const sel = window.getSelection();
  const hasSelection = sel && sel.rangeCount && !sel.isCollapsed;
  if (hasSelection) {
    document.execCommand('fontSize', false, '7');
    page().querySelectorAll('font[size="7"]').forEach(f => {
      f.removeAttribute('size'); f.style.fontSize = pt + 'pt';
    });
    _pendingFontSize = null;
  } else {
    _pendingFontSize = pt;
    if (page()) page().style.fontSize = pt + 'pt';
  }
  markModified(); page().focus();
}

function btn(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
}

// ─── Manual undo stack ────────────────────────────────────────────────────────
const _undoStack = [], _redoStack = [];
const MAX_UNDO = 50;
function pushUndo() {
  const p = page(); if (!p) return;
  _undoStack.push(p.innerHTML);
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  _redoStack.length = 0;
}
function undoManual() {
  if (_undoStack.length === 0) { execCmd('undo'); return; }
  const p = page(); if (!p) return;
  _redoStack.push(p.innerHTML);
  p.innerHTML = _undoStack.pop();
  markModified(); updateStatus();
}
function redoManual() {
  if (_redoStack.length === 0) { execCmd('redo'); return; }
  const p = page(); if (!p) return;
  _undoStack.push(p.innerHTML);
  p.innerHTML = _redoStack.pop();
  markModified(); updateStatus();
}

// ─── Find & Replace ───────────────────────────────────────────────────────────
function openFindBar(replaceMode) {
  const bar = document.getElementById('findBar');
  if (!bar) return;
  bar.style.display = 'flex';
  const rep = document.getElementById('replaceInput');
  if (rep) rep.style.display = replaceMode ? '' : 'none';
  const repBtn = document.getElementById('btn-replace-all');
  if (repBtn) repBtn.style.display = replaceMode ? '' : 'none';
  document.getElementById('findInput')?.focus();
}
function closeFindBar() {
  const bar = document.getElementById('findBar');
  if (bar) bar.style.display = 'none';
}
function doFind() {
  const term = document.getElementById('findInput')?.value;
  const status = document.getElementById('findStatus');
  if (!term) return;
  const found = window.find(term, false, false, true, false, true, false);
  if (status) status.textContent = found ? '' : 'Not found';
}
function doReplace() {
  const find = document.getElementById('findInput')?.value;
  const rep  = document.getElementById('replaceInput')?.value ?? '';
  const status = document.getElementById('findStatus');
  if (!find) return;
  pushUndo();
  const p = page();
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'gi');
  let count = 0;
  function walkTextNodes(node) {
    if (node.nodeType === 3) {
      const matches = node.textContent.match(regex);
      if (matches) {
        count += matches.length;
        const parts = node.textContent.split(regex);
        const frag = document.createDocumentFragment();
        parts.forEach((part, i) => {
          frag.appendChild(document.createTextNode(part));
          if (i < parts.length - 1) frag.appendChild(document.createTextNode(rep));
        });
        node.parentNode.replaceChild(frag, node);
      }
    } else if (node.nodeType === 1 && node.childNodes) {
      Array.from(node.childNodes).forEach(walkTextNodes);
    }
  }
  walkTextNodes(p);
  if (status) status.textContent = count ? `Replaced ${count} match(es)` : 'Not found';
  if (count) markModified();
}

// ─── Spell check ──────────────────────────────────────────────────────────────
let spellOn = true;
function toggleSpell() {
  spellOn = !spellOn;
  const p = page(); if (p) p.spellcheck = spellOn;
  const ind = document.getElementById('spellStatus');
  if (ind) ind.textContent = 'Spell: ' + (spellOn ? 'ON' : 'OFF');
}

// ─── Paragraph styles / line spacing / columns / page size ───────────────────
function applyStyle(tag) {
  // Chromium's formatBlock doesn't support 'pre' or 'blockquote' — wrap via DOM instead
  if (tag === 'pre' || tag === 'blockquote') {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    // Find the current block ancestor
    let block = range.commonAncestorContainer;
    if (block.nodeType === 3) block = block.parentElement;
    block = block.closest('p, div, h1, h2, h3, h4, h5, h6, pre, blockquote, li') || block;
    // If already that tag, unwrap back to p
    if (block.tagName.toLowerCase() === tag) {
      const p = document.createElement('p');
      p.innerHTML = block.innerHTML;
      block.parentNode.replaceChild(p, block);
    } else {
      const el = document.createElement(tag);
      el.innerHTML = block.innerHTML;
      block.parentNode.replaceChild(el, block);
    }
    markModified();
    return;
  }
  execCmd('formatBlock', tag);
  markModified();
}
function setLineSpacing(val) { const p = page(); if (p) p.style.lineHeight = val; markModified(); }
function setColumns(n) {
  const p = page(); if (!p) return;
  p.style.columnCount = n > 1 ? n : ''; p.style.columnGap = n > 1 ? '2em' : '';
  markModified();
}
function setPageSize(w, h) { const p = page(); if (!p) return; p.style.width = w; p.style.minHeight = h; }
function setMargins(t, r, b, l) { const p = page(); if (!p) return; p.style.padding = `${t} ${r} ${b} ${l}`; }
function setOrientation(o) { if (o === 'landscape') setPageSize('27.7cm','19.05cm'); else setPageSize('21cm','29.7cm'); }

// ─── Interactive Ruler ────────────────────────────────────────────────────────
const _ruler = {
  visible:      false,
  pageWidthPx:  794,   // default A4 width in px
  pageOffsetX:  0,     // left edge of page relative to ruler
  marginLeftPx: 90,    // default left padding in px (96px = 2.54cm ≈ 90px at 96dpi)
  marginRightPx:90,    // default right padding
  tabStops:     [],    // array of px positions relative to page left edge
  dragging:     null,  // 'left' | 'right' | number (tab index)
  dragStartX:   0,
};

// 1px ≈ 0.0265cm at 96dpi. Page is 794px wide = ~21cm (A4)
const PX_PER_CM = 37.8;

function toggleRuler() {
  const r = document.getElementById('ruler');
  if (!r) return;
  _ruler.visible = r.style.display === 'none' || r.style.display === '';
  r.style.display = _ruler.visible ? 'block' : 'none';
  if (_ruler.visible) {
    requestAnimationFrame(() => { _rulerSync(); _rulerDraw(); });
  }
}

function _rulerSync() {
  // Align ruler to page position
  const pageEl = page();
  const rulerEl = document.getElementById('ruler');
  if (!pageEl || !rulerEl) return;

  const pageRect  = pageEl.getBoundingClientRect();
  const rulerRect = rulerEl.getBoundingClientRect();
  _ruler.pageOffsetX  = pageRect.left - rulerRect.left;
  _ruler.pageWidthPx  = pageRect.width;

  // Read current margin from page padding
  const style     = window.getComputedStyle(pageEl);
  const padLeft   = parseFloat(style.paddingLeft)  || 90;
  const padRight  = parseFloat(style.paddingRight) || 90;
  _ruler.marginLeftPx  = padLeft;
  _ruler.marginRightPx = padRight;

  // Size the canvas
  const canvas = document.getElementById('ruler-canvas');
  if (canvas) {
    canvas.width  = rulerEl.offsetWidth;
    canvas.height = rulerEl.offsetHeight;
  }

  // Position margin handles
  const lh = document.getElementById('ruler-margin-left');
  const rh = document.getElementById('ruler-margin-right');
  if (lh) lh.style.left = (_ruler.pageOffsetX + _ruler.marginLeftPx - 7) + 'px';
  if (rh) rh.style.left = (_ruler.pageOffsetX + _ruler.pageWidthPx - _ruler.marginRightPx - 7) + 'px';

  _renderTabStops();
}

function _rulerDraw() {
  const canvas = document.getElementById('ruler-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;
  const dark = document.body.classList.contains('dark-mode');

  ctx.clearRect(0, 0, W, H);

  // Background zones: grey = margin, white = text area
  ctx.fillStyle = dark ? '#1a1a2e' : '#d8d8d8';
  ctx.fillRect(0, 0, W, H);

  const textLeft  = _ruler.pageOffsetX + _ruler.marginLeftPx;
  const textRight = _ruler.pageOffsetX + _ruler.pageWidthPx - _ruler.marginRightPx;
  ctx.fillStyle = dark ? '#2a2a4a' : '#fff';
  ctx.fillRect(textLeft, 0, textRight - textLeft, H);

  // Tick marks
  ctx.strokeStyle = dark ? '#555' : '#aaa';
  ctx.fillStyle   = dark ? '#bbb' : '#555';
  ctx.font        = '9px Segoe UI, Arial, sans-serif';
  ctx.textAlign   = 'center';

  const startCm = -(_ruler.pageOffsetX) / PX_PER_CM;
  const endCm   = (W - _ruler.pageOffsetX) / PX_PER_CM;

  for (let cm = Math.floor(startCm * 2) / 2; cm <= endCm; cm += 0.5) {
    const x = Math.round(_ruler.pageOffsetX + cm * PX_PER_CM);
    const isCm     = Number.isInteger(cm);
    const isFiveCm = isCm && cm % 5 === 0;
    const tickH    = isFiveCm ? H * 0.7 : isCm ? H * 0.5 : H * 0.3;

    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x, H - tickH);
    ctx.stroke();

    if (isCm && cm !== 0) {
      ctx.fillText(Math.abs(cm), x, H - tickH - 1);
    }
  }

  // Page boundary lines
  ctx.strokeStyle = dark ? '#3a3a6a' : '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(_ruler.pageOffsetX, 0);
  ctx.lineTo(_ruler.pageOffsetX, H);
  ctx.moveTo(_ruler.pageOffsetX + _ruler.pageWidthPx, 0);
  ctx.lineTo(_ruler.pageOffsetX + _ruler.pageWidthPx, H);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function _renderTabStops() {
  const container = document.getElementById('ruler-tabs');
  if (!container) return;
  container.innerHTML = '';
  _ruler.tabStops.forEach((tabPx, i) => {
    const el = document.createElement('div');
    el.className    = 'ruler-tab-stop';
    el.style.left   = (_ruler.pageOffsetX + tabPx) + 'px';
    el.title        = `Tab stop at ${(tabPx / PX_PER_CM).toFixed(1)}cm — double-click to remove`;
    el.dataset.idx  = i;
    el.addEventListener('dblclick', () => {
      _ruler.tabStops.splice(i, 1);
      _applyTabStops();
      _renderTabStops();
    });
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      _startRulerDrag(e, i);
    });
    container.appendChild(el);
  });
}

function _applyMargins() {
  const p = page();
  if (!p) return;
  const l = Math.max(20, _ruler.marginLeftPx);
  const r = Math.max(20, _ruler.marginRightPx);
  p.style.paddingLeft  = l + 'px';
  p.style.paddingRight = r + 'px';
  markModified();
}

function _applyTabStops() {
  const p = page();
  if (!p) return;
  let styleEl = document.getElementById('tab-stop-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'tab-stop-style';
    document.head.appendChild(styleEl);
  }
  if (_ruler.tabStops.length === 0) {
    // No custom stops — clear and use browser default
    styleEl.textContent = '';
    p.style.tabSize = '';
  } else {
    // Build CSS custom-tab-size value as a series of pixel lengths (Bug 4 fix)
    // tab-size accepts a length in CSS — we use the first stop as the base unit
    // and add subsequent stops spaced from each other
    const stops = _ruler.tabStops.slice().sort((a,b) => a - b);
    // Convert px to pt (1px = 0.75pt at 96dpi)
    const toPt = px => Math.round(px * 0.75);
    // Use CSS columns of tab stops via a <style> rule targeting #page
    // Each stop is expressed as distance from page left edge
    const stopList = stops.map(px => toPt(px) + 'pt').join(' ');
    styleEl.textContent = `#page { tab-size: ${toPt(stops[0])}pt; }`;
    // Also set as CSS variable for future use
    p.style.setProperty('--tab-stops', stopList);
  }
  markModified();
}

function _startRulerDrag(e, what) {
  _ruler.dragging  = what;
  _ruler.dragStartX = e.clientX;
  e.preventDefault();
}

function initRuler() {
  const rulerEl = document.getElementById('ruler');
  if (!rulerEl) return;

  // Click on ruler to add tab stop (not on a handle)
  rulerEl.addEventListener('click', (e) => {
    if (_ruler.dragging !== null) return;
    if (e.target.closest('.ruler-handle') || e.target.closest('.ruler-tab-stop')) return;
    const rulerRect = rulerEl.getBoundingClientRect();
    const clickX    = e.clientX - rulerRect.left;
    const pageRelX  = clickX - _ruler.pageOffsetX;
    // Only allow tab stops within text area
    if (pageRelX < _ruler.marginLeftPx || pageRelX > _ruler.pageWidthPx - _ruler.marginRightPx) return;
    _ruler.tabStops.push(pageRelX);
    _ruler.tabStops.sort((a,b) => a - b);
    _applyTabStops();
    _renderTabStops();
  });

  // Margin handle drag
  document.getElementById('ruler-margin-left')?.addEventListener('mousedown', e => {
    _startRulerDrag(e, 'left');
  });
  document.getElementById('ruler-margin-right')?.addEventListener('mousedown', e => {
    _startRulerDrag(e, 'right');
  });

  // Global drag handlers
  document.addEventListener('mousemove', (e) => {
    if (_ruler.dragging === null) return;
    const rulerEl  = document.getElementById('ruler');
    if (!rulerEl) return;
    const rulerRect = rulerEl.getBoundingClientRect();
    const mouseX    = e.clientX - rulerRect.left;

    if (_ruler.dragging === 'left') {
      const newMargin = Math.max(0, Math.min(mouseX - _ruler.pageOffsetX, _ruler.pageWidthPx - _ruler.marginRightPx - 40));
      _ruler.marginLeftPx = newMargin;
      const lh = document.getElementById('ruler-margin-left');
      if (lh) lh.style.left = (_ruler.pageOffsetX + newMargin - 7) + 'px';
      _applyMargins();
      _rulerDraw();

    } else if (_ruler.dragging === 'right') {
      const pageRight  = _ruler.pageOffsetX + _ruler.pageWidthPx;
      const newMargin  = Math.max(0, Math.min(pageRight - mouseX, _ruler.pageWidthPx - _ruler.marginLeftPx - 40));
      _ruler.marginRightPx = newMargin;
      const rh = document.getElementById('ruler-margin-right');
      if (rh) rh.style.left = (pageRight - newMargin - 7) + 'px';
      _applyMargins();
      _rulerDraw();

    } else if (typeof _ruler.dragging === 'number') {
      // Dragging a tab stop
      const pageRelX = mouseX - _ruler.pageOffsetX;
      if (pageRelX >= _ruler.marginLeftPx && pageRelX <= _ruler.pageWidthPx - _ruler.marginRightPx) {
        _ruler.tabStops[_ruler.dragging] = pageRelX;
        _renderTabStops();
        _applyTabStops();
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (_ruler.dragging !== null) {
      _ruler.dragging = null;
      _rulerDraw();
    }
  });

  // Redraw ruler on window resize
  window.addEventListener('resize', () => {
    if (_ruler.visible) { _rulerSync(); _rulerDraw(); }
  });

  // Redraw when zoom changes
  const origSetZoom = setZoom;
  // Ruler resyncs after zoom via updateStatus -> requestAnimationFrame
}
let fmtMarksOn = false;
function toggleFmtMarks() {
  fmtMarksOn = !fmtMarksOn;
  const p = page(); if (p) p.classList.toggle('show-marks', fmtMarksOn);
}
function toggleFullScreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
}

// ─── Color pickers ────────────────────────────────────────────────────────────
function initColorPickers() {
  const fc = document.getElementById('fontColor');
  const hc = document.getElementById('highlightColor');
  const bg = document.getElementById('bgFillColor');

  if (fc) fc.addEventListener('input', () => { execCmd('foreColor', fc.value); markModified(); });

  if (hc) hc.addEventListener('input', () => {
    const color = hc.value;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    // execCmd('backColor') doesn't work in Chromium — use span with inline style
    const range = sel.getRangeAt(0);
    const span  = document.createElement('span');
    span.style.backgroundColor = color;
    try {
      range.surroundContents(span);
    } catch (e) {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    sel.removeAllRanges();
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.addRange(newRange);
    markModified();
  });

  if (bg) bg.addEventListener('input', () => {
    // Background fill — applies to the whole page background (Fix 1)
    const color = bg.value;
    const p = page();
    if (p) p.style.backgroundColor = color;
    // Update the Bg button preview
    const bgSpan = bg.previousElementSibling;
    if (bgSpan) bgSpan.style.background = color;
    markModified();
  });
}

// ─── Image / Link ─────────────────────────────────────────────────────────────
async function insertImageFromFile() {
  const dataUri = await window.electronAPI.insertImage();
  if (!dataUri) return;
  execCmd('insertHTML', `<img src="${dataUri}" style="max-width:100%;display:block;margin:8px auto">`);
  markModified();
}
function insertLink() {
  const url = prompt('Enter URL:', 'https://');
  if (url && url !== 'https://') {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) execCmd('createLink', url);
    else execCmd('insertHTML', `<a href="${url}" target="_blank">${url}</a>`);
    markModified();
  }
}

// ─── Table insert ─────────────────────────────────────────────────────────────
function insertTable(rows, cols) {
  let html = '<table border="1" style="border-collapse:collapse;width:100%"><tbody>';
  for (let r = 0; r < rows; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) html += '<td style="padding:6px;min-width:60px;border:1px solid #bbb">&nbsp;</td>';
    html += '</tr>';
  }
  html += '</tbody></table><p><br></p>';
  execCmd('insertHTML', html); markModified();
}

// ─── Table context menu (NEW) ─────────────────────────────────────────────────
let _ctxTargetCell = null;

function initTableContextMenu() {
  const menu = document.getElementById('table-ctx-menu');

  page()?.addEventListener('contextmenu', (e) => {
    const td = e.target.closest('td, th');
    if (!td) return;
    e.preventDefault();
    _ctxTargetCell = td;
    menu.style.left = e.clientX + 'px';
    menu.style.top  = e.clientY + 'px';
    menu.classList.remove('hidden');
  });

  document.addEventListener('click', () => menu.classList.add('hidden'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.classList.add('hidden'); });

  btn('ctx-add-row-above', () => {
    if (!_ctxTargetCell) return;
    const row = _ctxTargetCell.closest('tr');
    const cols = row.cells.length;
    const newRow = row.cloneNode(false);
    for (let i = 0; i < cols; i++) {
      const td = document.createElement('td');
      td.style.cssText = 'padding:6px;min-width:60px;border:1px solid #bbb';
      td.innerHTML = '&nbsp;'; newRow.appendChild(td);
    }
    row.parentNode.insertBefore(newRow, row);
    markModified();
  });

  btn('ctx-add-row-below', () => {
    if (!_ctxTargetCell) return;
    const row = _ctxTargetCell.closest('tr');
    const cols = row.cells.length;
    const newRow = row.cloneNode(false);
    for (let i = 0; i < cols; i++) {
      const td = document.createElement('td');
      td.style.cssText = 'padding:6px;min-width:60px;border:1px solid #bbb';
      td.innerHTML = '&nbsp;'; newRow.appendChild(td);
    }
    row.parentNode.insertBefore(newRow, row.nextSibling);
    markModified();
  });

  btn('ctx-del-row', () => {
    if (!_ctxTargetCell) return;
    const row = _ctxTargetCell.closest('tr');
    const tbody = row.parentNode;
    if (tbody.rows.length <= 1) { alert('Cannot delete the only row.'); return; }
    tbody.removeChild(row); markModified();
  });

  btn('ctx-add-col-left', () => {
    if (!_ctxTargetCell) return;
    const table = _ctxTargetCell.closest('table');
    const colIdx = _ctxTargetCell.cellIndex;
    Array.from(table.rows).forEach(row => {
      const td = document.createElement(row.rowIndex === 0 ? 'th' : 'td');
      td.style.cssText = 'padding:6px;min-width:60px;border:1px solid #bbb';
      td.innerHTML = '&nbsp;';
      row.insertBefore(td, row.cells[colIdx]);
    });
    markModified();
  });

  btn('ctx-add-col-right', () => {
    if (!_ctxTargetCell) return;
    const table = _ctxTargetCell.closest('table');
    const colIdx = _ctxTargetCell.cellIndex;
    Array.from(table.rows).forEach(row => {
      const td = document.createElement(row.rowIndex === 0 ? 'th' : 'td');
      td.style.cssText = 'padding:6px;min-width:60px;border:1px solid #bbb';
      td.innerHTML = '&nbsp;';
      const after = row.cells[colIdx + 1];
      if (after) row.insertBefore(td, after); else row.appendChild(td);
    });
    markModified();
  });

  btn('ctx-del-col', () => {
    if (!_ctxTargetCell) return;
    const table = _ctxTargetCell.closest('table');
    const colIdx = _ctxTargetCell.cellIndex;
    if (table.rows[0].cells.length <= 1) { alert('Cannot delete the only column.'); return; }
    Array.from(table.rows).forEach(row => {
      if (row.cells[colIdx]) row.deleteCell(colIdx);
    });
    markModified();
  });

  btn('ctx-merge-cells', () => {
    alert('Select cells by holding Shift+Click first. Merge is available for adjacent cells in the same row.');
  });

  btn('ctx-del-table', () => {
    if (!_ctxTargetCell) return;
    const table = _ctxTargetCell.closest('table');
    // Simple 2-button confirm dialog (Bug 5 fix — no confirm() which has no Cancel)
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center';
    const bx = document.createElement('div');
    bx.style.cssText = 'background:#fff;border-radius:6px;padding:24px 28px;min-width:300px;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:Segoe UI,Arial,sans-serif';
    bx.innerHTML = `<div style="font-size:14px;font-weight:600;margin-bottom:12px">Delete Table</div>
      <div style="font-size:13px;color:#444;margin-bottom:20px">Delete this entire table? This cannot be undone.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="dtc-no"  style="padding:6px 16px;font-size:13px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#f5f5f5">Cancel</button>
        <button id="dtc-yes" style="padding:6px 16px;font-size:13px;border:none;border-radius:4px;cursor:pointer;background:#c00;color:#fff;font-weight:600">Delete</button>
      </div>`;
    ov.appendChild(bx);
    document.body.appendChild(ov);
    bx.querySelector('#dtc-no') .addEventListener('click', () => ov.remove());
    bx.querySelector('#dtc-yes').addEventListener('click', () => { ov.remove(); table.remove(); markModified(); });
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  });
}

// ─── Date/Time ────────────────────────────────────────────────────────────────
function insertDateTime() { execCmd('insertText', new Date().toLocaleString()); markModified(); }

// ─── Page Number ──────────────────────────────────────────────────────────────
function insertPageNumber() {
  execCmd('insertHTML', '<span class="page-num" data-page-num="true">1</span>');
  markModified();
  updatePageNumbers();
}
let _pageNumTimer = null;
function updatePageNumbers() {
  clearTimeout(_pageNumTimer);
  _pageNumTimer = setTimeout(() => {
    const p = page(); if (!p) return;
    p.querySelectorAll('span[data-page-num="true"]').forEach(span => {
      span.textContent = Math.max(1, Math.ceil((span.offsetTop || 0) / 1123));
    });
  }, 500);
}

// ─── Header / Footer (NEW) ───────────────────────────────────────────────────
let headerFooterOpen = false;
function toggleHeaderFooter() {
  headerFooterOpen = !headerFooterOpen;
  const hz = document.getElementById('header-zone');
  const fz = document.getElementById('footer-zone');
  if (hz) hz.style.display = headerFooterOpen ? 'block' : 'none';
  if (fz) fz.style.display = headerFooterOpen ? 'block' : 'none';
  if (headerFooterOpen) document.getElementById('doc-header')?.focus();
}
function initHeaderFooter() {
  btn('btn-header-footer', toggleHeaderFooter);
  btn('btn-close-header', () => {
    headerFooterOpen = false;
    const hz = document.getElementById('header-zone');
    const fz = document.getElementById('footer-zone');
    if (hz) hz.style.display = 'none';
    if (fz) fz.style.display = 'none';
    page()?.focus();
  });
  const dh = document.getElementById('doc-header');
  const df = document.getElementById('doc-footer');
  if (dh) dh.addEventListener('input', markModified);
  if (df) df.addEventListener('input', markModified);
}

// ─── Table of Contents (Bug 4 fix: adds delete button) ───────────────────────
function insertTOC() {
  const p = page();
  if (!p) return;
  const headings = p.querySelectorAll('h1, h2, h3');
  if (headings.length === 0) {
    alert('No headings found. Add H1, H2, or H3 headings to generate a Table of Contents.');
    return;
  }
  let entries = '';
  headings.forEach(h => {
    const tag   = h.tagName.toLowerCase();
    const level = tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3;
    const text  = h.textContent.trim() || '(untitled)';
    entries += `<div class="toc-entry level-${level}"><span>${text}</span><span class="toc-dots"></span><span class="toc-page">1</span></div>`;
  });
  // Bug 4 fix: wrap in a div that has a visible delete button
  const html = `<div class="toc-block" contenteditable="false">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8pt;border-bottom:1px solid #dde;padding-bottom:6pt">
      <b style="font-size:13pt;color:#1e4d8c">Table of Contents</b>
      <button onclick="this.closest('.toc-block').remove()" style="font-size:11px;padding:2px 8px;border:1px solid #ccc;border-radius:3px;cursor:pointer;background:#fff;color:#c00">✕ Remove</button>
    </div>
    ${entries}
  </div><p><br></p>`;
  execCmd('insertHTML', html);
  markModified();
}

// ─── Word Count Panel ─────────────────────────────────────────────────────────
function toggleWordCountPanel() {
  const panel = document.getElementById('wordCountPanel');
  if (!panel) return;
  const visible = panel.style.display !== 'none';
  if (visible) { panel.style.display = 'none'; return; }
  const text  = page()?.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const paras = text.split(/\n\n+/).filter(s => s.trim()).length || 1;
  const lines = text.split('\n').length;
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;border-bottom:1px solid #eee;padding-bottom:6px">Word Count</div>
    <table style="font-size:12px;width:100%;border-collapse:collapse">
      <tr><td style="padding:3px 0;color:#555">Words</td><td style="text-align:right;font-weight:600">${words}</td></tr>
      <tr><td style="padding:3px 0;color:#555">Characters</td><td style="text-align:right;font-weight:600">${chars}</td></tr>
      <tr><td style="padding:3px 0;color:#555">Paragraphs</td><td style="text-align:right;font-weight:600">${paras}</td></tr>
      <tr><td style="padding:3px 0;color:#555">Lines</td><td style="text-align:right;font-weight:600">${lines}</td></tr>
    </table>
    <div style="margin-top:10px;border-top:1px solid #eee;padding-top:8px">
      <b style="font-size:11px;color:#555">Set Word Count Target:</b><br>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input type="number" id="wc-target-input" placeholder="e.g. 500" min="1" style="width:90px;padding:3px 6px;font-size:12px;border:1px solid #ccc;border-radius:3px">
        <button id="wc-target-set" style="padding:3px 10px;font-size:12px;border:1px solid #1e4d8c;border-radius:3px;background:#1e4d8c;color:#fff;cursor:pointer">Set</button>
      </div>
    </div>
    <div style="margin-top:8px;text-align:right"><button onclick="document.getElementById('wordCountPanel').style.display='none'" style="font-size:11px;padding:2px 8px;cursor:pointer;border:1px solid #ccc;border-radius:3px">Close</button></div>`;
  panel.style.display = 'block';
  // Set button wired once via delegation in initWordTarget() — no btn() here (Bug 12 fix)
}

// ─── Word Count Target (NEW) ─────────────────────────────────────────────────
let _wordTarget = 0;
function setWordTarget(n) {
  _wordTarget = n;
  const bar = document.getElementById('wc-target-bar');
  if (bar) bar.classList.toggle('visible', n > 0);
  const text = page()?.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  updateWordTarget(words);
  // Persist target to settings (Bug 9 fix)
  if (_currentSettings) {
    const s = Object.assign({}, _currentSettings, { wordTarget: n });
    _currentSettings = s;
    saveSettings(s);
  }
}
function updateWordTarget(words) {
  if (!_wordTarget) return;
  const pct = Math.min(100, Math.round((words / _wordTarget) * 100));
  const pb = document.getElementById('wc-progress-bar');
  const lbl = document.getElementById('wc-target-label');
  if (pb) { pb.style.width = pct + '%'; pb.style.background = pct >= 100 ? '#28a745' : '#1e4d8c'; }
  if (lbl) lbl.textContent = `${words} / ${_wordTarget} words (${pct}%)`;
}
function initWordTarget() {
  btn('btn-clear-target', () => {
    _wordTarget = 0;
    const bar = document.getElementById('wc-target-bar');
    if (bar) bar.classList.remove('visible');
    if (_currentSettings) { const s = Object.assign({}, _currentSettings, { wordTarget: 0 }); _currentSettings = s; saveSettings(s); }
  });
  // Wire Set button once via delegation — avoids stacking listeners (Bug 12 fix)
  document.addEventListener('click', (e) => {
    if (e.target?.id === 'wc-target-set') {
      const val = parseInt(document.getElementById('wc-target-input')?.value);
      if (val && val > 0) { setWordTarget(val); document.getElementById('wordCountPanel').style.display = 'none'; }
    }
  });
}

// ─── Dark Mode ────────────────────────────────────────────────────────────────
let darkMode = false;
function toggleDarkMode() {
  darkMode = !darkMode;
  document.body.classList.toggle('dark-mode', darkMode);
  const btnDm = document.getElementById('btn-dark-mode');
  if (btnDm) btnDm.classList.toggle('rbtn-active', darkMode);
  // Update native titleBarOverlay to match dark/light mode (Fix 2)
  const overlayColor = darkMode ? '#0f0f1a' : (_currentSettings?.themeColor || '#1e4d8c');
  window.electronAPI.setTitleBarColor?.(overlayColor);
  const settings = _currentSettings ? { ..._currentSettings } : defaultSettings();
  settings.darkMode = darkMode;
  _currentSettings = settings;
  saveSettings(settings);
}

// ─── Reading Mode (Bug 5 fix: zoom updates wrapper height) ───────────────────
let readingZoom = 100;
let readingMode = false;

function updateReadingZoom() {
  const rp   = document.getElementById('reading-page');
  const body = document.querySelector('.reading-body');
  if (rp) {
    rp.style.transform       = `scale(${readingZoom / 100})`;
    rp.style.transformOrigin = 'top center';
  }
  // Fix gap: shrink reading body padding so scaled page fills correctly
  if (body && rp) {
    requestAnimationFrame(() => {
      const scale = readingZoom / 100;
      const h = Math.round((rp.scrollHeight + 80) * scale);
      body.style.minHeight = h + 'px';
    });
  }
  const lbl = document.getElementById('reading-zoom-label');
  if (lbl) lbl.textContent = readingZoom + '%';
}
function openReadingMode() {
  const overlay = document.getElementById('reading-overlay');
  const rp      = document.getElementById('reading-page');
  const srcPage = page();
  if (!overlay || !rp || !srcPage) return;
  rp.innerHTML = srcPage.innerHTML;
  const computed = window.getComputedStyle(srcPage);
  rp.style.fontFamily = srcPage.style.fontFamily || computed.fontFamily || '';
  rp.style.fontSize   = srcPage.style.fontSize   || computed.fontSize   || '13pt';
  rp.style.lineHeight = srcPage.style.lineHeight || computed.lineHeight || '1.8';
  rp.style.color      = srcPage.style.color      || computed.color      || '#222';
  overlay.classList.remove('hidden');
  readingMode = true;
  readingZoom = 100;
  requestAnimationFrame(updateReadingZoom);
}
function closeReadingMode() {
  document.getElementById('reading-overlay')?.classList.add('hidden');
  readingMode = false;
}
function initReadingMode() {
  // btn-reading-mode wired in wireButtons() for consistent DOMContentLoaded timing
  btn('btn-close-reading', closeReadingMode);
  btn('reading-zoom-in',  () => { readingZoom = Math.min(200, readingZoom + 10); updateReadingZoom(); });
  btn('reading-zoom-out', () => { readingZoom = Math.max(50,  readingZoom - 10); updateReadingZoom(); });
}

// ─── Distraction-Free Mode (NEW) ─────────────────────────────────────────────
let dfMode = false;
// Named handler so we can removeEventListener — prevents stacking (Bug 1 fix)
function _dfInputHandler() {
  const srcPage = page();
  const dfPage  = document.getElementById('df-page');
  if (!dfPage || !srcPage) return;
  srcPage.innerHTML = dfPage.innerHTML;
  markModified(); updateStatus();
  const text = dfPage.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  updateDfStatus(words, text.length);
}
function openDfMode() {
  const overlay = document.getElementById('df-overlay');
  const dfPage  = document.getElementById('df-page');
  const srcPage = page();
  if (!overlay || !dfPage || !srcPage) return;
  dfPage.innerHTML = srcPage.innerHTML;
  const computed = window.getComputedStyle(srcPage);
  dfPage.style.fontFamily = srcPage.style.fontFamily || computed.fontFamily || '';
  dfPage.style.fontSize   = srcPage.style.fontSize   || computed.fontSize   || '13pt';
  dfPage.style.lineHeight = srcPage.style.lineHeight || computed.lineHeight || '1.7';
  dfPage.style.color      = srcPage.style.color      || computed.color      || '#111';
  dfPage.removeEventListener('input', _dfInputHandler);
  dfPage.addEventListener('input', _dfInputHandler);
  overlay.classList.remove('hidden');
  dfMode = true;
  dfPage.focus();
}
function closeDfMode() {
  const overlay = document.getElementById('df-overlay');
  const dfPage  = document.getElementById('df-page');
  const srcPage = page();
  if (dfPage && srcPage) srcPage.innerHTML = dfPage.innerHTML;
  dfPage?.removeEventListener('input', _dfInputHandler);
  overlay?.classList.add('hidden');
  dfMode = false;
  markModified(); updateStatus();
}
function updateDfStatus(words, chars) {
  if (!dfMode) return;
  const wc = document.getElementById('df-word-count');
  const cc = document.getElementById('df-char-count');
  if (wc) wc.textContent = `Words: ${words}`;
  if (cc) cc.textContent = `Chars: ${chars}`;
}
function initDfMode() {
  // btn-distraction-free wired in wireButtons() for consistent DOMContentLoaded timing
  btn('btn-df-exit', closeDfMode);
  btn('btn-df-save', () => { closeDfMode(); window.electronAPI.menuSave(); });
  const overlay = document.getElementById('df-overlay');
  const toolbar = document.getElementById('df-toolbar');
  if (overlay && toolbar) {
    overlay.addEventListener('mousemove', (e) => {
      if (e.clientY < 60) toolbar.classList.add('visible');
      else toolbar.classList.remove('visible');
    });
  }
}

// ─── Special characters ───────────────────────────────────────────────────────
function insertChar(ch) { execCmd('insertText', ch); markModified(); }

// ─── Table grid ───────────────────────────────────────────────────────────────
function highlightGrid(rows, cols) {
  document.querySelectorAll('.grid-cell').forEach(el => {
    el.classList.toggle('active', +el.dataset.r <= rows && +el.dataset.c <= cols);
  });
  const lbl = document.getElementById('tableGridLabel');
  if (lbl) lbl.textContent = `${rows} × ${cols}`;
}
function hideTablePicker() { const p = document.getElementById('tablePicker'); if (p) p.style.display = 'none'; }

// ─── Settings (file-based via IPC) ────────────────────────────────────────────
let _currentSettings = null;
function defaultSettings() {
  return { spellCheck: true, showRuler: false, autoSave: false, defaultFont: 'Times New Roman', defaultFontSize: 12, darkMode: false, themeColor: '#1e4d8c', wordTarget: 0 };
}
async function loadSettings() {
  try {
    const s = await window.electronAPI.loadSettings();
    return s ? { ...defaultSettings(), ...s } : defaultSettings();
  } catch { return defaultSettings(); }
}
async function saveSettings(s) {
  try { await window.electronAPI.saveSettings(s); } catch {}
}
function applySettings(s) {
  _currentSettings = s;
  const p = page();
  if (p) p.spellcheck = s.spellCheck;
  spellOn = s.spellCheck;
  const spellInd = document.getElementById('spellStatus');
  if (spellInd) spellInd.textContent = 'Spell: ' + (spellOn ? 'ON' : 'OFF');
  const ruler = document.getElementById('ruler');
  if (ruler) ruler.style.display = s.showRuler ? 'block' : 'none';
  const fontSel = document.getElementById('fontFamily');
  if (fontSel && s.defaultFont) { fontSel.value = s.defaultFont; if (p) p.style.fontFamily = s.defaultFont; }
  const sizeIn = document.getElementById('fontSize');
  if (sizeIn && s.defaultFontSize) { sizeIn.value = s.defaultFontSize; if (p) p.style.fontSize = s.defaultFontSize + 'pt'; }
  if (window._autoSaveTimer) clearInterval(window._autoSaveTimer);
  if (s.autoSave) {
    window._autoSaveTimer = setInterval(() => {
      // Bug 12 fix — save to active tab's own filePath, not main.js currentFile
      if (_modified) {
        const fp = _tabs[_activeTab]?.filePath;
        if (fp) window.electronAPI.menuSaveToPath(fp);
        else window.electronAPI.menuSave();
      }
    }, 5 * 60 * 1000);
  }
  if (s.darkMode) { darkMode = true; document.body.classList.add('dark-mode'); }
  if (s.themeColor) applyThemeColor(s.themeColor);
  if (s.wordTarget > 0) setWordTarget(s.wordTarget);
  // Load personal dictionary
  if (Array.isArray(s.userDictionary)) {
    s.userDictionary.forEach(w => _userDict.add(w.toLowerCase()));
  }
}

function applyThemeColor(color) {
  document.documentElement.style.setProperty('--theme', color);
  const els = document.querySelectorAll('#titlebar, #ribbon-tabs, #statusbar');
  els.forEach(el => el.style.background = color);
  const fileLogo = document.querySelector('.file-panel-logo');
  if (fileLogo) { fileLogo.style.color = color; }
  const fileHeader = document.querySelector('.file-panel-header');
  if (fileHeader) fileHeader.style.background = color;
  const appIcon = document.getElementById('app-icon');
  if (appIcon) appIcon.style.color = color;
  // Also update native titlebar overlay colour (titleBarOverlay)
  window.electronAPI.setTitleBarColor?.(color);
}

// ─── Recent Files (Bug 3 fix: use IPC file storage, not localStorage) ────────
const MAX_RECENT = 10;
async function getRecentFiles() {
  try {
    const s = await window.electronAPI.loadSettings();
    return (s && Array.isArray(s.recentFiles)) ? s.recentFiles : [];
  } catch { return []; }
}
async function addRecentFile(filePath) {
  try {
    const s = await window.electronAPI.loadSettings() || {};
    let recent = Array.isArray(s.recentFiles) ? s.recentFiles : [];
    recent = recent.filter(f => f !== filePath);
    recent.unshift(filePath);
    if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
    s.recentFiles = recent;
    await window.electronAPI.saveSettings(s);
  } catch {}
}
async function showRecentFiles() {
  const recent = await getRecentFiles();
  if (recent.length === 0) {
    showFpRight(`<div class="fp-right-section"><div class="fp-right-title">Recent Files</div><p style="color:#888;font-size:13px;margin-top:12px">No recent files yet. Open or save a document to see it here.</p></div>`);
    return;
  }
  let items = recent.map(fp => {
    const name = fp.split('\\').pop() || fp.split('/').pop() || fp;
    return `<div class="fp-recent-item" data-fp="${fp.replace(/"/g,'&quot;')}">
      <span style="font-size:18px">&#128196;</span>
      <div style="overflow:hidden;flex:1">
        <div class="fp-recent-name">${name}</div>
        <div class="fp-recent-path">${fp}</div>
      </div>
    </div>`;
  }).join('');
  showFpRight(`<div class="fp-right-section"><div class="fp-right-title">Recent Files</div><p class="fp-right-desc">Click a file to open it</p>${items}</div>`);
  document.querySelectorAll('.fp-recent-item[data-fp]').forEach(el => {
    el.addEventListener('click', () => {
      const fp = el.dataset.fp;
      if (fp) { closeFilePanel(); window.electronAPI.menuOpenPath(fp); }
    });
  });
}

// ─── Print Preview ────────────────────────────────────────────────────────────
let ppZoom = 100;
function updatePpZoom() {
  const pp = document.getElementById('pp-page');
  const wrap = document.querySelector('.pp-page-wrap');
  if (pp) pp.style.transform = `scale(${ppZoom / 100})`;
  if (wrap && pp) {
    const scale = ppZoom / 100;
    wrap.style.width  = Math.round((794 + 40) * scale) + 'px';
    wrap.style.height = Math.round((pp.scrollHeight + 60) * scale) + 'px';
  }
  const lbl = document.getElementById('pp-zoom-label');
  if (lbl) lbl.textContent = ppZoom + '%';
}
function openPrintPreview() {
  const overlay = document.getElementById('print-preview-overlay');
  const ppPage  = document.getElementById('pp-page');
  const srcPage = page();
  if (!overlay || !ppPage || !srcPage) return;

  const hZone  = document.getElementById('header-zone');
  const fZone  = document.getElementById('footer-zone');
  const header = document.getElementById('doc-header');
  const footer = document.getElementById('doc-footer');
  const hasHeader = hZone && hZone.style.display !== 'none' && header && header.innerHTML.trim();
  const hasFooter = fZone && fZone.style.display !== 'none' && footer && footer.innerHTML.trim();

  let ppHtml = '';
  if (hasHeader) ppHtml += `<div style="border-bottom:1px solid #ccc;padding:6px 0;margin-bottom:12pt;font-size:10pt;color:#555">${header.innerHTML}</div>`;
  ppHtml += srcPage.innerHTML;
  if (hasFooter) ppHtml += `<div style="border-top:1px solid #ccc;padding:6px 0;margin-top:12pt;font-size:10pt;color:#555">${footer.innerHTML}</div>`;

  ppPage.innerHTML        = ppHtml;
  ppPage.style.fontFamily = srcPage.style.fontFamily  || '';
  ppPage.style.fontSize   = srcPage.style.fontSize    || '';
  ppPage.style.lineHeight = srcPage.style.lineHeight  || '';
  ppPage.style.padding    = srcPage.style.padding     || '';
  ppPage.style.width      = srcPage.style.width       || '794px';
  ppPage.style.minHeight  = srcPage.style.minHeight   || '1123px';
  ppPage.style.columnCount= srcPage.style.columnCount || '';
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => { ppZoom = 100; updatePpZoom(); });
}
function closePrintPreview() { document.getElementById('print-preview-overlay')?.classList.add('hidden'); }
function initPrintPreview() {
  btn('pp-close', closePrintPreview);
  btn('pp-print-btn', () => { closePrintPreview(); setTimeout(() => window.electronAPI.menuPrint(), 200); });
  btn('pp-zoom-in',  () => { ppZoom = Math.min(200, ppZoom + 10); updatePpZoom(); });
  btn('pp-zoom-out', () => { ppZoom = Math.max(30,  ppZoom - 10); updatePpZoom(); });
  document.getElementById('print-preview-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'print-preview-overlay') closePrintPreview();
  });
}

// ─── File Panel ───────────────────────────────────────────────────────────────
function openFilePanel() {
  document.getElementById('file-panel')?.classList.remove('hidden');
  document.getElementById('file-overlay')?.classList.remove('hidden');
}
function closeFilePanel() {
  document.getElementById('file-panel')?.classList.add('hidden');
  document.getElementById('file-overlay')?.classList.add('hidden');
}
function showFpRight(html) {
  const right = document.getElementById('file-panel-right');
  if (right) right.innerHTML = html;
}

function initFilePanel() {
  btn('btn-file-tab',  openFilePanel);
  btn('btn-file-close', closeFilePanel);
  document.getElementById('file-overlay')?.addEventListener('click', closeFilePanel);

  btn('fp-new',  () => { closeFilePanel(); window.electronAPI.menuNew(); });
  btn('fp-open', () => { closeFilePanel(); window.electronAPI.menuOpen(); });
  btn('fp-save', () => { closeFilePanel(); window.electronAPI.menuSave(); });
  btn('fp-recent', () => showRecentFiles()); // async — returns promise, that's fine

  btn('fp-save-as', () => {
    showFpRight(`<div class="fp-right-section">
      <div class="fp-right-title">Save As</div>
      <p class="fp-right-desc">Choose a format to save your document</p>
      <button class="fp-right-btn" id="fpr-docx">&#128196; Word Document (.docx)</button>
      <button class="fp-right-btn" id="fpr-doc">&#128196; Word Document (.doc)</button>
      <button class="fp-right-btn" id="fpr-html">&#127760; Web Page (.html)</button>
      <button class="fp-right-btn" id="fpr-txt">&#128196; Plain Text (.txt)</button>
    </div>`);
    ['fpr-docx','fpr-doc','fpr-html','fpr-txt'].forEach(id => {
      const extMap = { 'fpr-docx':'docx', 'fpr-doc':'doc', 'fpr-html':'html', 'fpr-txt':'txt' };
      btn(id, () => { closeFilePanel(); window.electronAPI.menuSaveAs(extMap[id]); });
    });
  });

  btn('fp-share', () => {
    showFpRight(`<div class="fp-right-section">
      <div class="fp-right-title">Share</div>
      <button class="fp-right-btn" id="fpr-share-copy">&#128203; Copy file path</button>
      <button class="fp-right-btn" id="fpr-share-email">&#9993; Share via Email</button>
    </div>`);
    btn('fpr-share-copy', () => {
      const fp = _tabs[_activeTab]?.filePath;
      if (!fp) { flashSaved('Save the document first to get a file path'); return; }
      navigator.clipboard.writeText(fp).then(() => {
        flashSaved('✔ File path copied to clipboard');
      }).catch(() => flashSaved('Could not copy — try Ctrl+C after selecting'));
    });
    btn('fpr-share-email', () => { closeFilePanel(); window.electronAPI.menuEmail?.(); });
  });

  btn('fp-export-pdf',     () => { closeFilePanel(); window.electronAPI.menuExportPdf?.(); });
  btn('fp-export-picture', () => { showFpRight(`<div class="fp-right-section"><div class="fp-right-title">Export to Picture</div><p class="fp-right-desc">Saves page as PNG image</p><button class="fp-right-btn" id="fpr-png">PNG Image</button></div>`); btn('fpr-png', () => { closeFilePanel(); window.print(); }); });
  btn('fp-output-pptx',   () => { showFpRight(`<div class="fp-right-section"><div class="fp-right-title">Output as PPTX</div><p class="fp-right-desc">Coming in a future version</p></div>`); });

  btn('fp-print', () => {
    showFpRight(`<div class="fp-right-section">
      <div class="fp-right-title">Print</div>
      <button class="fp-right-btn" id="fpr-print-now">&#128438; Print Now</button>
      <button class="fp-right-btn" id="fpr-print-preview-fp">&#128196; Print Preview</button>
    </div>`);
    btn('fpr-print-now', () => { closeFilePanel(); setTimeout(() => window.electronAPI.menuPrint(), 200); });
    btn('fpr-print-preview-fp', () => { closeFilePanel(); setTimeout(openPrintPreview, 200); });
  });

  btn('fp-print-preview', () => { closeFilePanel(); setTimeout(openPrintPreview, 200); });

  btn('fp-email', () => {
    showFpRight(`<div class="fp-right-section"><div class="fp-right-title">Send E-mail</div><button class="fp-right-btn" id="fpr-email-attach">&#9993; Send as Attachment</button></div>`);
    btn('fpr-email-attach', () => { closeFilePanel(); window.electronAPI.menuEmail?.(); });
  });

  btn('fp-encrypt', () => {
    showFpRight(`<div class="fp-right-section">
      <div class="fp-right-title">Encrypt Document</div>
      <p class="fp-right-desc">Password-protect your document</p>
      <div style="margin:12px 0">
        <input type="password" id="enc-pass1" placeholder="Enter password" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:3px;margin-bottom:6px;font-size:13px"><br>
        <input type="password" id="enc-pass2" placeholder="Confirm password" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:3px;font-size:13px">
      </div>
      <button class="fp-right-btn" id="fpr-encrypt-apply">&#128274; Apply Encryption</button>
      <p style="font-size:11px;color:#888;margin-top:8px">Preview only — full encryption coming in a future update.</p>
    </div>`);
    btn('fpr-encrypt-apply', () => {
      const p1 = document.getElementById('enc-pass1')?.value;
      const p2 = document.getElementById('enc-pass2')?.value;
      if (!p1) { alert('Please enter a password.'); return; }
      if (p1 !== p2) { alert('Passwords do not match.'); return; }
      alert('Encryption coming in next update.'); closeFilePanel();
    });
  });

  btn('fp-backup', () => {
    showFpRight(`<div class="fp-right-section">
      <div class="fp-right-title">Backup and Restore</div>
      <button class="fp-right-btn" id="fpr-backup-now">&#128190; Backup Now</button>
      <button class="fp-right-btn" id="fpr-backup-restore">&#8635; Restore from Backup</button>
    </div>`);
    btn('fpr-backup-now',     () => { closeFilePanel(); window.electronAPI.menuBackup?.(); });
    btn('fpr-backup-restore', () => { closeFilePanel(); window.electronAPI.menuOpen(); });
  });

  btn('fp-help', () => {
    showFpRight(`<div class="fp-right-section">
      <div class="fp-right-title">Help</div>
      <button class="fp-right-btn" id="fpr-about">&#x1F4CB; About JainDocument</button>
      <button class="fp-right-btn" id="fpr-shortcuts">&#9875; Keyboard Shortcuts</button>
      <button class="fp-right-btn" id="fpr-update">&#8635; Check for Updates</button>
    </div>`);
    btn('fpr-about',   () => { closeFilePanel(); window.electronAPI.menuAbout?.(); });
    btn('fpr-update',  () => { closeFilePanel(); window.electronAPI.menuCheckUpdates?.(); });
    btn('fpr-shortcuts', () => {
      showFpRight(`<div class="fp-right-section">
        <div class="fp-right-title">Keyboard Shortcuts</div>
        <table style="font-size:12px;width:100%;border-collapse:collapse">
          ${[['Ctrl+N','New'],['Ctrl+O','Open'],['Ctrl+S','Save'],['Ctrl+Shift+S','Save As'],
             ['Ctrl+P','Print'],['Ctrl+Z','Undo'],['Ctrl+Y','Redo'],
             ['Ctrl+B','Bold'],['Ctrl+I','Italic'],['Ctrl+U','Underline'],
             ['Ctrl+L','Align Left'],['Ctrl+E','Center'],['Ctrl+R','Align Right'],
             ['Ctrl+J','Justify'],['Ctrl+F','Find'],['Ctrl+H','Replace'],
             ['Ctrl+A','Select All'],['F11','Full Screen'],['Esc','Close Find / Exit Modes']
          ].map(([k,v]) => `<tr style="border-bottom:1px solid #f0f0f0"><td style="padding:4px;color:#555">${k}</td><td style="padding:4px;font-weight:500">${v}</td></tr>`).join('')}
        </table>
      </div>`);
    });
  });

  btn('fp-options', async () => {
    const settings = await loadSettings();
    showFpRight(`<div class="fp-right-section">
      <div class="fp-right-title">Options</div>
      <p class="fp-right-desc">Applied immediately on save</p>
      <div style="margin:10px 0;font-size:13px">
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">
          <input type="checkbox" id="opt-spell" ${settings.spellCheck?'checked':''}> Enable spell check
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">
          <input type="checkbox" id="opt-ruler" ${settings.showRuler?'checked':''}> Show ruler
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">
          <input type="checkbox" id="opt-autosave" ${settings.autoSave?'checked':''}> Auto-save every 5 min
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">
          <input type="checkbox" id="opt-darkmode" ${settings.darkMode?'checked':''}> Dark mode
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">
          Theme colour:
          <input type="color" id="opt-theme" value="${settings.themeColor||'#1e4d8c'}" style="width:36px;height:24px;border:none;cursor:pointer;margin-left:4px">
        </label>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer">
          Default font:
          <select id="opt-font" style="font-size:12px;padding:2px 6px;border:1px solid #ccc;border-radius:3px;margin-left:4px">
            <option ${settings.defaultFont==='Times New Roman'?'selected':''}>Times New Roman</option>
            <option ${settings.defaultFont==='Arial'?'selected':''}>Arial</option>
            <option ${settings.defaultFont==='Calibri'?'selected':''}>Calibri</option>
            <option ${settings.defaultFont==='Georgia'?'selected':''}>Georgia</option>
            <option ${settings.defaultFont==='Verdana'?'selected':''}>Verdana</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          Default size:
          <input type="number" id="opt-fontsize" value="${settings.defaultFontSize||12}" min="6" max="96"
            style="width:60px;font-size:12px;padding:2px 6px;border:1px solid #ccc;border-radius:3px;margin-left:4px"> pt
        </label>
      </div>
      <button class="fp-right-btn" id="fpr-opts-save" style="margin-top:10px;background:#1e4d8c;color:#fff;border-color:#1e4d8c">&#10003; Apply &amp; Save Options</button>
      <div id="opts-saved-msg" style="display:none;color:green;font-size:12px;margin-top:8px">&#10003; Settings applied!</div>
    </div>`);
    btn('fpr-opts-save', () => {
      const newSettings = Object.assign({}, _currentSettings || defaultSettings(), {
        spellCheck:      document.getElementById('opt-spell')?.checked ?? true,
        showRuler:       document.getElementById('opt-ruler')?.checked ?? false,
        autoSave:        document.getElementById('opt-autosave')?.checked ?? false,
        darkMode:        document.getElementById('opt-darkmode')?.checked ?? false,
        themeColor:      document.getElementById('opt-theme')?.value || '#1e4d8c',
        defaultFont:     document.getElementById('opt-font')?.value || 'Times New Roman',
        defaultFontSize: parseInt(document.getElementById('opt-fontsize')?.value) || 12,
        wordTarget:      _wordTarget || 0,
      });
      saveSettings(newSettings);
      applySettings(newSettings);
      const msg = document.getElementById('opts-saved-msg');
      if (msg) { msg.style.display = 'block'; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
    });
  });

  btn('fp-exit', () => { closeFilePanel(); window.electronAPI.menuExit(); });
}

// ─── Multi-Document Tabs ──────────────────────────────────────────────────────
let _tabs      = [];
let _activeTab = 0;
let _tabSeq    = 0;

function _newTabObj(title, html, filePath) {
  return {
    id:         ++_tabSeq,
    title:      title || 'Untitled',
    filePath:   filePath || null,
    html:       html || '',
    headerHtml: '',
    footerHtml: '',
    modified:   false,
  };
}

// Save current page state into the active tab object
function _saveActiveTabState() {
  if (!_tabs.length) return;
  const tab = _tabs[_activeTab];
  if (!tab) return;
  const p  = page();
  const dh = document.getElementById('doc-header');
  const df = document.getElementById('doc-footer');
  tab.html       = p  ? p.innerHTML  : '';
  tab.headerHtml = dh ? dh.innerHTML : '';
  tab.footerHtml = df ? df.innerHTML : '';
}

// Load a tab object's state into the page
function _loadTabState(tab) {
  const p  = page();
  const dh = document.getElementById('doc-header');
  const df = document.getElementById('doc-footer');
  if (p)  p.innerHTML  = tab.html       || '';
  if (dh) dh.innerHTML = tab.headerHtml || '';
  if (df) df.innerHTML = tab.footerHtml || '';
  updatePlaceholder();
  updateStatus();
  // Update main process state via IPC signals
  if (tab.modified) window.electronAPI.markModified();
  else              window.electronAPI.markClean();
  // Update title bar
  const titleEl = document.getElementById('app-title');
  if (titleEl) titleEl.textContent = `${tab.modified ? '● ' : ''}${tab.title} — JainDocument`;
}

// Render the tab bar
function renderTabs() {
  const list = document.getElementById('tab-list');
  if (!list) return;
  list.innerHTML = _tabs.map((tab, i) => `
    <div class="doc-tab ${i === _activeTab ? 'active' : ''} ${tab.modified ? 'modified' : ''}"
         data-idx="${i}" title="${tab.filePath || tab.title}">
      <span class="tab-title">${tab.title}</span>
      <button class="tab-close" data-idx="${i}" title="Close tab">&#x2715;</button>
    </div>`).join('');

  // Wire tab clicks
  list.querySelectorAll('.doc-tab').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      switchTab(parseInt(el.dataset.idx));
    });
  });
  list.querySelectorAll('.tab-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(parseInt(btn.dataset.idx));
    });
  });
}

function switchTab(idx) {
  if (idx === _activeTab) return;
  _saveActiveTabState();
  _activeTab = idx;
  _modified  = _tabs[idx]?.modified || false;
  _loadTabState(_tabs[idx]);
  renderTabs();
}

function newTab(html, filePath, title) {
  _saveActiveTabState();
  const name = title || (filePath ? filePath.split('\\').pop().split('/').pop() : 'Untitled');
  const tab  = _newTabObj(name, html || '', filePath);
  _tabs.push(tab);
  _activeTab = _tabs.length - 1;
  _modified  = false;
  _loadTabState(tab);
  renderTabs();
  page()?.focus();
}

// 3-option close-tab dialog (Bug 9 fix)
window._showCloseTabDialog = function(title) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:6px;padding:24px 28px;min-width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:Segoe UI,Arial,sans-serif';
    box.innerHTML = `
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">Unsaved Changes</div>
      <div style="font-size:13px;color:#444;margin-bottom:20px">Save changes to "<b>${title}</b>" before closing?</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="ctd-cancel"  style="padding:6px 16px;font-size:13px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#f5f5f5">Cancel</button>
        <button id="ctd-discard" style="padding:6px 16px;font-size:13px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#f5f5f5;color:#c00">Don't Save</button>
        <button id="ctd-save"    style="padding:6px 16px;font-size:13px;border:none;border-radius:4px;cursor:pointer;background:#1e4d8c;color:#fff;font-weight:600">Save</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = (val) => { overlay.remove(); resolve(val); };
    box.querySelector('#ctd-cancel') .addEventListener('click', () => close('cancel'));
    box.querySelector('#ctd-discard').addEventListener('click', () => close('discard'));
    box.querySelector('#ctd-save')   .addEventListener('click', () => close('save'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close('cancel'); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close('cancel'); }
    });
  });
};

async function closeTab(idx) {
  const tab = _tabs[idx];
  if (!tab) return;

  if (tab.modified) {
    // Switch to this tab so user can see what they're saving
    if (idx !== _activeTab) switchTab(idx);
    const choice = await window._showCloseTabDialog(tab.title);
    if (choice === 'cancel') return;   // Bug 9 fix — truly cancel, keep tab open
    if (choice === 'save') {
      // Bug 17 fix — if tab has its own filePath, save directly to that path.
      // Otherwise use Save As so the user picks a name.
      if (tab.filePath) {
        await window.electronAPI.menuSaveToPath(tab.filePath);
      } else {
        await window.electronAPI.menuSave();
      }
    }
    // 'discard' falls through and closes without saving
  }

  _tabs.splice(idx, 1);

  if (_tabs.length === 0) {
    _tabs.push(_newTabObj('Untitled', '', null));
  }

  _activeTab = Math.max(0, Math.min(idx === _activeTab ? idx - 1 : _activeTab < idx ? _activeTab : _activeTab - 1, _tabs.length - 1));
  _modified  = _tabs[_activeTab]?.modified || false;
  _loadTabState(_tabs[_activeTab]);
  renderTabs();
}

// Update the active tab's modified state and title
function _updateActiveTab(modified, filePath) {
  const tab = _tabs[_activeTab];
  if (!tab) return;
  if (modified !== undefined) tab.modified = modified;
  if (filePath !== undefined) {
    tab.filePath = filePath;
    tab.title    = filePath ? filePath.split('\\').pop().split('/').pop() : tab.title;
  }
  const titleEl = document.getElementById('app-title');
  if (titleEl) titleEl.textContent = `${tab.modified ? '● ' : ''}${tab.title} — JainDocument`;
  renderTabs();
}

function initTabs() {
  // Initialize with one blank tab
  _tabs      = [_newTabObj('Untitled', '', null)];
  _activeTab = 0;

  // Tab switching (ribbon tabs — NOT doc tabs)
  document.querySelectorAll('.rtab[data-tab]').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const target = tabBtn.dataset.tab;
      document.querySelectorAll('.rtab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.ribbon-panel').forEach(p => p.classList.remove('active'));
      tabBtn.classList.add('active');
      const panel = document.querySelector(`.ribbon-panel[data-panel="${target}"]`);
      if (panel) panel.classList.add('active');
    });
  });

  // New tab button
  document.getElementById('tab-new-btn')?.addEventListener('click', () => newTab());

  // Ctrl+T for new tab
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 't') { e.preventDefault(); newTab(); }
    if (e.ctrlKey && e.key === 'w') { e.preventDefault(); closeTab(_activeTab); }
  });

  renderTabs();
}

// ─── Wire all buttons ─────────────────────────────────────────────────────────
// ─── Mail Merge ───────────────────────────────────────────────────────────────
let _mmData      = [];   // array of row objects { field: value, ... }
let _mmHeaders   = [];   // column headers
let _mmRecordIdx = 0;    // current preview index
let _mmFileName  = '';

// ── CSV parser (handles quoted fields, commas inside quotes) ──────────────────
function parseCSV(text) {
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  function parseLine(line) {
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i+1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        fields.push(cur.trim()); cur = '';
      } else cur += ch;
    }
    fields.push(cur.trim());
    return fields;
  }

  const headers = parseLine(lines[0]).map(h => h.replace(/^"|"$/g,'').trim());
  const rows = lines.slice(1).map(line => {
    const vals = parseLine(line);
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g,'').trim(); });
    return obj;
  }).filter(r => Object.values(r).some(v => v));

  return { headers, rows };
}

// ── Apply merge fields to template HTML ──────────────────────────────────────
function applyMerge(templateHtml, record) {
  let result = templateHtml;
  Object.entries(record).forEach(([field, value]) => {
    // Replace {{Field}}, {{ Field }}, <<Field>>, [Field] — all common formats
    const patterns = [
      new RegExp(`\\{\\{\\s*${_escapeRegex(field)}\\s*\\}\\}`, 'gi'),
      new RegExp(`<<\\s*${_escapeRegex(field)}\\s*>>`, 'gi'),
      new RegExp(`\\[\\s*${_escapeRegex(field)}\\s*\\]`, 'gi'),
    ];
    patterns.forEach(p => { result = result.replace(p, value); });
  });
  return result;
}
function _escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Open/close modal ──────────────────────────────────────────────────────────
function openMailMerge() {
  const overlay = document.getElementById('mm-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  if (_mmData.length > 0) _showMmDataStep();
  else _showMmNoDataStep();
}
function closeMailMerge() {
  document.getElementById('mm-overlay')?.classList.add('hidden');
}
function _showMmNoDataStep() {
  document.getElementById('mm-step-nodata')?.classList.remove('hidden');
  document.getElementById('mm-step-data')?.classList.add('hidden');
}
function _showMmDataStep() {
  document.getElementById('mm-step-nodata')?.classList.add('hidden');
  document.getElementById('mm-step-data')?.classList.remove('hidden');
  document.getElementById('mm-filename').textContent     = _mmFileName;
  document.getElementById('mm-record-count').textContent = _mmData.length;
  document.getElementById('mm-field-list').textContent   = _mmHeaders.join(', ');
  _renderFieldButtons();
  _updateMmPreview();
}

// ── Field buttons ─────────────────────────────────────────────────────────────
function _renderFieldButtons() {
  const container = document.getElementById('mm-field-btns');
  if (!container) return;
  container.innerHTML = _mmHeaders.map(h =>
    `<button class="mm-field-tag" onclick="insertMergeField('${h.replace(/'/g,"\\'")}')">{{${h}}}</button>`
  ).join('');
}
function insertMergeField(fieldName) {
  execCmd('insertHTML', `<span class="mm-field-marker">{{${fieldName}}}</span>`);
  markModified();
  closeMailMerge();
}

// ── Preview ───────────────────────────────────────────────────────────────────
function _updateMmPreview() {
  const box = document.getElementById('mm-preview-box');
  const lbl = document.getElementById('mm-rec-label');
  if (!box || !_mmData.length) return;
  _mmRecordIdx = Math.max(0, Math.min(_mmRecordIdx, _mmData.length - 1));
  const templateHtml = page()?.innerHTML || '';
  box.innerHTML = applyMerge(templateHtml, _mmData[_mmRecordIdx]);
  if (lbl) lbl.textContent = `Record ${_mmRecordIdx + 1} of ${_mmData.length}`;
}

// ── Merge All ─────────────────────────────────────────────────────────────────
function mergeAllRecords() {
  if (!_mmData.length) { flashSaved('No CSV data loaded'); return; }
  const templateHtml = page()?.innerHTML || '';
  if (!templateHtml.trim()) { flashSaved('Document is empty — add content with {{Field}} placeholders first'); return; }

  const merged = _mmData.map((record, i) => {
    const html = applyMerge(templateHtml, record);
    return i < _mmData.length - 1
      ? html + '<hr class="page-break" style="border-top:2px dashed #5b9bd5;margin:24pt 0"><p><br></p>'
      : html;
  }).join('');

  const p = page();
  if (p) {
    pushUndo();
    p.innerHTML = merged;
    markModified();
    updateStatus();
  }
  closeMailMerge();
  flashSaved(`✔ Merged ${_mmData.length} records`);
}

// ── Init ──────────────────────────────────────────────────────────────────────
function initMailMerge() {
  btn('mm-close',            closeMailMerge);
  btn('mm-btn-load-csv',     loadCsvFile);
  btn('mm-btn-reload-csv',   loadCsvFile);
  btn('mm-btn-merge-all',    mergeAllRecords);
  btn('mm-prev-rec',         () => { _mmRecordIdx--; _updateMmPreview(); });
  btn('mm-next-rec',         () => { _mmRecordIdx++; _updateMmPreview(); });
  btn('btn-mm-load',         loadCsvFile);
  btn('btn-mm-preview',      openMailMerge);
  btn('btn-mm-merge',        () => {
    if (!_mmData.length) { flashSaved('Load a CSV file first'); return; }
    mergeAllRecords();
  });
  btn('btn-mm-insert-field', () => {
    if (!_mmHeaders.length) { flashSaved('Load a CSV file first'); return; }
    openMailMerge();
  });
  btn('btn-mm-clear',        () => {
    _mmData = []; _mmHeaders = []; _mmFileName = ''; _mmRecordIdx = 0;
    // Remove field markers from page
    page()?.querySelectorAll('.mm-field-marker').forEach(el => {
      el.parentNode.replaceChild(document.createTextNode(el.textContent), el);
    });
    flashSaved('Mail Merge data cleared');
  });
  // Close on overlay click
  document.getElementById('mm-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'mm-overlay') closeMailMerge();
  });
}

async function loadCsvFile() {
  const result = await window.electronAPI.openCsv?.();
  if (!result) return;
  const { content, fileName } = result;
  const { headers, rows } = parseCSV(content);
  if (!headers.length || !rows.length) {
    flashSaved('CSV appears empty or invalid'); return;
  }
  _mmHeaders   = headers;
  _mmData      = rows;
  _mmRecordIdx = 0;
  _mmFileName  = fileName;
  openMailMerge();
  _showMmDataStep();
  flashSaved(`✔ Loaded ${rows.length} records from ${fileName}`);
}

// ─── Track Changes ────────────────────────────────────────────────────────────
let _trackingOn = false;
let _tcAuthor   = 'Author';
let _tcIgnore   = false;

function toggleTrackChanges() {
  _trackingOn = !_trackingOn;
  const tcBtn = document.getElementById('btn-track-changes');
  if (tcBtn) tcBtn.classList.toggle('rbtn-active', _trackingOn);
  if (_trackingOn) { _startTracking(); flashSaved('Track Changes: ON'); }
  else             { _stopTracking();  flashSaved('Track Changes: OFF'); }
}

function _startTracking() {
  const p = page();
  if (!p) return;
  // Remove first to guarantee no duplicate listeners
  p.removeEventListener('keydown',     _tcKeyHandler);
  p.removeEventListener('beforeinput', _tcBeforeInputHandler);
  p.addEventListener('keydown',     _tcKeyHandler);
  p.addEventListener('beforeinput', _tcBeforeInputHandler);
}

function _stopTracking() {
  const p = page();
  if (p) {
    p.removeEventListener('keydown',     _tcKeyHandler);
    p.removeEventListener('beforeinput', _tcBeforeInputHandler);
  }
}

function _tcKeyHandler(e) {
  if (!_trackingOn || _tcIgnore) return;
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) {
      e.preventDefault();
      _tcIgnore = true;
      const fragment = range.extractContents();
      const del = document.createElement('del');
      del.className = 'tc-del';
      del.dataset.author = _tcAuthor;
      del.dataset.date   = new Date().toISOString().slice(0,10);
      del.title = `Deleted by ${_tcAuthor}`;
      del.appendChild(fragment);
      range.insertNode(del);
      range.setStartAfter(del); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
      _tcIgnore = false;
      markModified();
    }
  }
}

function _tcBeforeInputHandler(e) {
  if (!_trackingOn || _tcIgnore) return;

  // Input types we intercept for track changes (Bug 3 fix)
  const INSERT_TYPES = new Set([
    'insertText', 'insertFromPaste', 'insertFromPasteAsQuotation',
    'insertFromDrop', 'insertReplacementText', 'insertFromYank',
    'insertTranspose', 'insertCompositionText',
  ]);
  const DELETE_TYPES = new Set([
    'deleteContentBackward', 'deleteContentForward',
    'deleteByCut', 'deleteByDrag',
    'deleteWordBackward', 'deleteWordForward',
    'deleteSoftLineBackward', 'deleteSoftLineForward',
    'deleteHardLineBackward', 'deleteHardLineForward',
    'deleteContent',
  ]);

  const isInsert = INSERT_TYPES.has(e.inputType);
  const isDelete = DELETE_TYPES.has(e.inputType);
  if (!isInsert && !isDelete) return;

  e.preventDefault();
  _tcIgnore = true;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) { _tcIgnore = false; return; }
  const range = sel.getRangeAt(0);
  const today = new Date().toISOString().slice(0, 10);

  // Helper — wrap a DOM fragment in a <del>
  function _wrapDel(frag) {
    const del = document.createElement('del');
    del.className      = 'tc-del';
    del.dataset.author = _tcAuthor;
    del.dataset.date   = today;
    del.title          = `Deleted by ${_tcAuthor}`;
    del.appendChild(frag);
    return del;
  }

  // Helper — create an <ins> with text or HTML content
  function _makeIns(content, isHtml) {
    const ins = document.createElement('ins');
    ins.className      = 'tc-ins';
    ins.dataset.author = _tcAuthor;
    ins.dataset.date   = today;
    ins.title          = `Inserted by ${_tcAuthor}`;
    if (isHtml) ins.innerHTML = content;
    else        ins.textContent = content || '';
    return ins;
  }

  if (isDelete) {
    // For delete ops, mark selected content as deleted; for single-char
    // backward/forward deletes with no selection, expand range by one char
    if (range.collapsed) {
      try {
        if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward' || e.inputType === 'deleteSoftLineBackward' || e.inputType === 'deleteHardLineBackward') {
          range.setStart(range.startContainer, Math.max(0, range.startOffset - 1));
        } else {
          const node = range.endContainer;
          const max  = node.nodeType === 3 ? node.textContent.length : node.childNodes.length;
          range.setEnd(node, Math.min(max, range.endOffset + 1));
        }
      } catch(err) {}
    }
    if (!range.collapsed) {
      const frag = range.extractContents();
      const del  = _wrapDel(frag);
      range.insertNode(del);
      range.setStartAfter(del); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    }

  } else {
    // Insert — first mark any selected content as deleted
    if (!range.collapsed) {
      const frag = range.extractContents();
      const del  = _wrapDel(frag);
      range.insertNode(del);
      range.setStartAfter(del); range.collapse(true);
    }

    // Get the text/html to insert
    let insertText = e.data || '';
    let insertHtml = false;

    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromPasteAsQuotation') {
      // Try to get plain text from clipboard data
      try {
        const dt = e.dataTransfer || window._lastClipboardData;
        if (dt) {
          insertText = dt.getData('text/plain') || dt.getData('text') || '';
        }
      } catch(err) {}
    } else if (e.inputType === 'insertFromDrop') {
      try {
        insertText = e.dataTransfer?.getData('text/plain') || '';
      } catch(err) {}
    }

    if (insertText || insertHtml) {
      const ins = _makeIns(insertText, insertHtml);
      range.insertNode(ins);
      range.setStartAfter(ins); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    }
  }

  _tcIgnore = false;
  markModified();
}

function acceptSelectedChange() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) { flashSaved('Select a tracked change first'); return; }
  const node = sel.anchorNode;
  const ins = node?.parentElement?.closest('ins.tc-ins');
  const del = node?.parentElement?.closest('del.tc-del');
  if (ins) {
    const parent = ins.parentNode;
    while (ins.firstChild) parent.insertBefore(ins.firstChild, ins);
    parent.removeChild(ins);
    markModified(); flashSaved('Insertion accepted');
  } else if (del) {
    del.parentNode.removeChild(del);
    markModified(); flashSaved('Deletion accepted');
  } else { flashSaved('No tracked change at cursor'); }
}

function rejectSelectedChange() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) { flashSaved('Select a tracked change first'); return; }
  const node = sel.anchorNode;
  const ins = node?.parentElement?.closest('ins.tc-ins');
  const del = node?.parentElement?.closest('del.tc-del');
  if (ins) {
    ins.parentNode.removeChild(ins);
    markModified(); flashSaved('Insertion rejected');
  } else if (del) {
    const parent = del.parentNode;
    while (del.firstChild) parent.insertBefore(del.firstChild, del);
    parent.removeChild(del);
    markModified(); flashSaved('Deletion rejected');
  } else { flashSaved('No tracked change at cursor'); }
}

function acceptAllChanges() {
  const p = page(); if (!p) return;
  p.querySelectorAll('ins.tc-ins').forEach(ins => {
    const parent = ins.parentNode;
    while (ins.firstChild) parent.insertBefore(ins.firstChild, ins);
    parent.removeChild(ins);
  });
  p.querySelectorAll('del.tc-del').forEach(del => del.parentNode.removeChild(del));
  markModified(); flashSaved('All changes accepted');
}

function rejectAllChanges() {
  const p = page(); if (!p) return;
  p.querySelectorAll('ins.tc-ins').forEach(ins => ins.parentNode.removeChild(ins));
  p.querySelectorAll('del.tc-del').forEach(del => {
    const parent = del.parentNode;
    while (del.firstChild) parent.insertBefore(del.firstChild, del);
    parent.removeChild(del);
  });
  markModified(); flashSaved('All changes rejected');
}

// ─── Comments ─────────────────────────────────────────────────────────────────
let _commentCounter  = 0;
let _activeCommentId = null;
const _comments      = {};

function addComment() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    flashSaved('Select text to comment on first'); return;
  }
  const text = prompt('Add comment:');
  if (!text || !text.trim()) return;

  _commentCounter++;
  const cid = 'c' + _commentCounter;
  _comments[cid] = { text: text.trim(), author: _tcAuthor, date: new Date().toLocaleDateString() };

  try {
    const range = sel.getRangeAt(0);
    const span  = document.createElement('span');
    span.className   = 'tc-comment';
    span.dataset.cid = cid;
    span.title       = `${_tcAuthor}: ${text.trim()}`;
    span.addEventListener('click', () => setActiveComment(cid));
    range.surroundContents(span);
    sel.removeAllRanges();
  } catch(e) {
    flashSaved('Select text within a single paragraph');
    delete _comments[cid]; _commentCounter--; return;
  }

  markModified();
  renderCommentPanel();
  setActiveComment(cid);
}

function setActiveComment(cid) {
  _activeCommentId = cid;
  document.querySelectorAll('.tc-comment').forEach(s => s.classList.remove('tc-comment-active'));
  const span = document.querySelector(`.tc-comment[data-cid="${cid}"]`);
  if (span) { span.classList.add('tc-comment-active'); span.scrollIntoView({ block:'center', behavior:'smooth' }); }
  document.querySelectorAll('.comment-card').forEach(c => c.classList.remove('comment-card-active'));
  const card = document.querySelector(`.comment-card[data-cid="${cid}"]`);
  if (card) card.classList.add('comment-card-active');
}

function navigateComment(dir) {
  const cids = Object.keys(_comments);
  if (!cids.length) { flashSaved('No comments in document'); return; }
  const idx  = cids.indexOf(_activeCommentId);
  const next = cids[(idx + dir + cids.length) % cids.length];
  setActiveComment(next);
}

function deleteSelectedComment() {
  if (!_activeCommentId) { flashSaved('Click a comment to select it first'); return; }
  _removeComment(_activeCommentId);
  _activeCommentId = null;
  renderCommentPanel(); markModified();
}

function deleteAllComments() {
  if (!Object.keys(_comments).length) { flashSaved('No comments in document'); return; }
  Object.keys(_comments).forEach(cid => _removeComment(cid));
  _activeCommentId = null;
  renderCommentPanel(); markModified();
}

function _removeComment(cid) {
  const span = document.querySelector(`.tc-comment[data-cid="${cid}"]`);
  if (span) {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  delete _comments[cid];
}

function renderCommentPanel() {
  const panel = document.getElementById('comment-panel');
  if (!panel) return;
  const cids = Object.keys(_comments);
  if (!cids.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  panel.innerHTML = `
    <div class="comment-panel-header">
      <span>&#128172; Comments (${cids.length})</span>
      <button class="comment-clear-btn" id="comment-clear-all-btn">Clear All</button>
    </div>
    ${cids.map(cid => {
      const c = _comments[cid];
      return `<div class="comment-card" data-cid="${cid}">
        <div class="comment-card-meta">${c.author} &bull; ${c.date}</div>
        <div class="comment-card-text">${c.text}</div>
        <button class="comment-card-del" data-del-cid="${cid}" title="Delete comment">&#x2715;</button>
      </div>`;
    }).join('')}`;

  panel.querySelector('#comment-clear-all-btn')
    ?.addEventListener('click', () => deleteAllComments());

  panel.querySelectorAll('.comment-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.comment-card-del')) return;
      setActiveComment(card.dataset.cid);
    });
  });

  panel.querySelectorAll('.comment-card-del').forEach(delBtn => {
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _removeComment(delBtn.dataset.delCid);
      renderCommentPanel();
      markModified();
    });
  });

  document.querySelectorAll('.tc-comment').forEach(s => {
    s.removeEventListener('click', s._commentClickHandler);
    s._commentClickHandler = () => setActiveComment(s.dataset.cid);
    s.addEventListener('click', s._commentClickHandler);
  });

  if (_activeCommentId) setActiveComment(_activeCommentId);
}

// ─── Wire buttons ─────────────────────────────────────────────────────────────
function wireButtons() {
  // Window controls now handled natively by Windows titleBarOverlay
  // Custom snap popup removed — Windows provides native snap layout flyout

  btn('btn-undo', () => undoManual());
  btn('btn-redo', () => redoManual());
  btn('btn-cut',  () => { execCmd('cut');  markModified(); });
  btn('btn-copy', () => execCmd('copy'));
  btn('btn-paste', async () => {
    try {
      const text = await navigator.clipboard.readText();
      execCmd('insertText', text); markModified();
    } catch {
      page().focus();
      const bar = document.getElementById('saveStatus');
      if (bar) { bar.textContent = 'Press Ctrl+V to paste'; setTimeout(() => { bar.textContent = ''; }, 2500); }
    }
  });

  btn('btn-bold',      () => { execCmd('bold');          markModified(); });
  btn('btn-italic',    () => { execCmd('italic');        markModified(); });
  btn('btn-underline', () => { execCmd('underline');     markModified(); });
  btn('btn-strike',    () => { execCmd('strikeThrough'); markModified(); });
  btn('btn-super',     () => { execCmd('superscript');   markModified(); });
  btn('btn-sub',       () => { execCmd('subscript');     markModified(); });
  btn('btn-clear-fmt', () => { execCmd('removeFormat');  markModified(); });

  btn('btn-align-left',    () => { execCmd('justifyLeft');   markModified(); });
  btn('btn-align-center',  () => { execCmd('justifyCenter'); markModified(); });
  btn('btn-align-right',   () => { execCmd('justifyRight');  markModified(); });
  btn('btn-align-justify', () => { execCmd('justifyFull');   markModified(); });

  btn('btn-bullet',   () => { execCmd('insertUnorderedList'); markModified(); });
  btn('btn-numbered', () => { execCmd('insertOrderedList');   markModified(); });
  btn('btn-indent',   () => { execCmd('indent');  markModified(); });
  btn('btn-outdent',  () => { execCmd('outdent'); markModified(); });

  btn('btn-h1',     () => applyStyle('h1'));
  btn('btn-h2',     () => applyStyle('h2'));
  btn('btn-h3',     () => applyStyle('h3'));
  btn('btn-h4',     () => applyStyle('h4'));
  btn('btn-normal', () => applyStyle('p'));
  btn('btn-quote',  () => applyStyle('blockquote'));
  btn('btn-code',   () => applyStyle('pre'));

  const lsEl = document.getElementById('lineSpacing');
  if (lsEl) lsEl.addEventListener('change', () => setLineSpacing(lsEl.value));

  btn('btn-find',                () => openFindBar(false));
  btn('btn-find-replace',        () => openFindBar(true));
  btn('btn-select-all',          () => execCmd('selectAll'));
  btn('btn-find-next',           doFind);
  btn('btn-replace-all',         doReplace);
  btn('btn-find-close',          closeFindBar);
  btn('btn-find-review',         () => openFindBar(false));
  btn('btn-find-replace-review', () => openFindBar(true));

  const fi = document.getElementById('findInput');
  if (fi) fi.addEventListener('keydown', e => { if (e.key === 'Enter') doFind(); });

  // Insert tab
  btn('btn-image',      insertImageFromFile);
  btn('btn-link',       insertLink);
  btn('btn-hr',         () => { execCmd('insertHorizontalRule'); markModified(); });
  btn('btn-page-break', () => { execCmd('insertHTML', '<hr class="page-break"><p><br></p>'); markModified(); });
  btn('btn-datetime',   insertDateTime);
  btn('btn-page-num',   insertPageNumber);
  btn('btn-toc',        insertTOC);

  // Table grid
  const grid = document.getElementById('tableGrid');
  if (grid) {
    const ROWS = 8, COLS = 10;
    for (let r = 1; r <= ROWS; r++) {
      for (let c = 1; c <= COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.r = r; cell.dataset.c = c;
        cell.addEventListener('mouseenter', () => highlightGrid(r, c));
        cell.addEventListener('click', () => { insertTable(r, c); hideTablePicker(); });
        grid.appendChild(cell);
      }
    }
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${COLS}, 20px)`;
  }
  btn('btn-table', () => {
    const picker = document.getElementById('tablePicker');
    if (picker) picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#tablePicker') && !e.target.closest('#btn-table')) hideTablePicker();
  });

  document.querySelectorAll('.special-char').forEach(el => {
    el.addEventListener('click', () => insertChar(el.textContent));
  });

  // Layout
  btn('btn-margin-normal',  () => setMargins('2.54cm','2.54cm','2.54cm','2.54cm'));
  btn('btn-margin-narrow',  () => setMargins('1.27cm','1.27cm','1.27cm','1.27cm'));
  btn('btn-margin-wide',    () => setMargins('2.54cm','5.08cm','2.54cm','5.08cm'));
  btn('btn-portrait',       () => setOrientation('portrait'));
  btn('btn-landscape',      () => setOrientation('landscape'));
  btn('btn-size-a4',        () => setPageSize('21cm','29.7cm'));
  btn('btn-size-a3',        () => setPageSize('29.7cm','42cm'));
  btn('btn-size-a5',        () => setPageSize('14.8cm','21cm'));
  btn('btn-size-letter',    () => setPageSize('21.59cm','27.94cm'));
  btn('btn-col-1',          () => setColumns(1));
  btn('btn-col-2',          () => setColumns(2));
  btn('btn-col-3',          () => setColumns(3));

  // Review
  btn('btn-spell-toggle', toggleSpell);
  btn('btn-word-count',   toggleWordCountPanel);
  document.addEventListener('click', e => {
    if (!e.target.closest('#wordCountPanel') && !e.target.closest('#btn-word-count')) {
      const p = document.getElementById('wordCountPanel');
      if (p) p.style.display = 'none';
    }
  });
  // Review — Track Changes & Comments (full implementation)
  btn('btn-track-changes',       toggleTrackChanges);
  btn('btn-accept-change',       acceptSelectedChange);
  btn('btn-reject-change',       rejectSelectedChange);
  btn('btn-accept-all',          acceptAllChanges);
  btn('btn-reject-all',          rejectAllChanges);
  btn('btn-add-comment',         addComment);
  btn('btn-prev-comment',        () => navigateComment(-1));
  btn('btn-next-comment',        () => navigateComment(1));
  btn('btn-delete-comment',      deleteSelectedComment);
  btn('btn-delete-all-comments', deleteAllComments);

  // References tab
  btn('btn-toc-ref',      insertTOC);
  btn('btn-footnote',     () => { execCmd('insertHTML','<sup style="font-size:8pt;color:#888;vertical-align:super">[fn]</sup>'); markModified(); });
  btn('btn-endnote',      () => { execCmd('insertHTML','<span style="font-size:8pt;color:#888">†</span>'); markModified(); });
  btn('btn-citation',     () => { const c = prompt('Citation (e.g. Author, Year):'); if(c) { execCmd('insertHTML',`<span style="font-size:9pt;color:#555">(${c})</span>`); markModified(); } });
  btn('btn-bibliography', () => alert('Bibliography generator coming in a future update.'));
  btn('btn-bookmark',     () => { const n = prompt('Bookmark name:'); if(n) { execCmd('insertHTML',`<a id="${n.replace(/\s+/g,'_')}" style="color:inherit;text-decoration:none" title="Bookmark: ${n}">&#128278;</a>`); markModified(); } });
  btn('btn-crossref',     () => { const t = prompt('Bookmark name to link to:'); if(t) { execCmd('insertHTML',`<a href="#${t.replace(/\s+/g,'_')}" style="color:#1e4d8c">&#8594; ${t}</a>`); markModified(); } });

  // Tools tab
  btn('btn-word-count-tools', toggleWordCountPanel);
  btn('btn-char-count',       () => { const text = page()?.innerText||''; alert(`Characters (with spaces): ${text.length}\nCharacters (no spaces): ${text.replace(/\s/g,'').length}`); });
  btn('btn-wc-target-tools',  () => { const v = parseInt(prompt('Word count target (e.g. 500):')||'0'); if(v>0) setWordTarget(v); });
  btn('btn-macro-record',     () => alert('Macro recording coming in a future update.'));
  btn('btn-macro-stop',       () => alert('No macro recording in progress.'));
  btn('btn-macro-play',       () => alert('No macros saved yet.'));
  btn('btn-macro-list',       () => alert('No macros saved yet.'));
  btn('btn-options-tools',    () => openFilePanel());
  btn('btn-backup-tools',     () => window.electronAPI.menuBackup?.());

  // View
  btn('btn-zoom-in',    () => setZoom(zoomLevel + 10));
  btn('btn-zoom-out',   () => setZoom(zoomLevel - 10));
  btn('btn-zoom-reset', () => setZoom(100));
  btn('btn-ruler-toggle',     toggleRuler);
  btn('btn-fmt-marks',        toggleFmtMarks);
  btn('btn-fullscreen',       toggleFullScreen);
  btn('btn-dark-mode',        toggleDarkMode);

  const zs1 = document.getElementById('zoomSlider');
  if (zs1) zs1.addEventListener('input', () => setZoom(parseInt(zs1.value)));
  const zs2 = document.getElementById('zoomSlider2');
  if (zs2) zs2.addEventListener('input', () => setZoom(parseInt(zs2.value)));
  btn('zoomMinus', () => setZoom(zoomLevel - 10));
  btn('zoomPlus',  () => setZoom(zoomLevel + 10));
}

// ─── Page listeners ───────────────────────────────────────────────────────────
function initPage() {
  const p = page(); if (!p) return;
  p.addEventListener('input', () => { markModified(); updatePlaceholder(); updateStatus(); });
  p.addEventListener('keyup',   updateStatus);
  p.addEventListener('mouseup', updateStatus);
  p.addEventListener('focus', () => {
    if (p.classList.contains('placeholder')) { p.innerHTML = ''; p.classList.remove('placeholder'); }
  });
  p.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'S') { e.preventDefault(); const ext = _tabs[_activeTab]?.filePath?.split('.').pop() || 'docx'; window.electronAPI.menuSaveAs(ext); return; }
    if (e.ctrlKey && !e.shiftKey && e.key === 's') { e.preventDefault(); window.electronAPI.menuSave(); return; }
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); window.electronAPI.menuNew();   return; }
    if (e.ctrlKey && e.key === 'o') { e.preventDefault(); window.electronAPI.menuOpen();  return; }
    if (e.ctrlKey && e.key === 'p') { e.preventDefault(); window.electronAPI.menuPrint(); return; }
    if (e.ctrlKey && e.key === 'f') { e.preventDefault(); openFindBar(false); return; }
    if (e.ctrlKey && e.key === 'h') { e.preventDefault(); openFindBar(true);  return; }
    if (e.ctrlKey && e.key === 'b') { e.preventDefault(); execCmd('bold');          markModified(); return; }
    if (e.ctrlKey && e.key === 'i') { e.preventDefault(); execCmd('italic');        markModified(); return; }
    if (e.ctrlKey && e.key === 'u') { e.preventDefault(); execCmd('underline');     markModified(); return; }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); execCmd('justifyLeft');   markModified(); return; }
    if (e.ctrlKey && e.key === 'e') { e.preventDefault(); execCmd('justifyCenter'); markModified(); return; }
    if (e.ctrlKey && e.key === 'r') { e.preventDefault(); execCmd('justifyRight');  markModified(); return; }
    if (e.ctrlKey && e.key === 'j') { e.preventDefault(); execCmd('justifyFull');   markModified(); return; }
    if (e.key === 'Escape') {
      closeFindBar();
      if (readingMode) closeReadingMode();
      if (dfMode) closeDfMode();
      return;
    }
  });
  updatePlaceholder();
}

// ─── IPC from main ────────────────────────────────────────────────────────────
function initIPC() {
  window.electronAPI.onNew(() => {
    // newTab() sets modified=false on the new tab — no markClean() needed (Bug 6 fix)
    newTab('', null, 'Untitled');
  });

  window.electronAPI.onOpen(({ html, filePath }) => {
    // If file already open in a tab, switch to it
    const existing = _tabs.findIndex(t => t.filePath === filePath);
    if (existing >= 0) { switchTab(existing); return; }
    // Replace current tab if it's blank and unmodified
    const cur = _tabs[_activeTab];
    if (cur && !cur.modified && !cur.filePath && !cur.html.trim()) {
      cur.html = html; cur.filePath = filePath;
      cur.title = filePath ? filePath.split('\\').pop().split('/').pop() : 'Untitled';
      cur.modified = false;
      _loadTabState(cur); renderTabs();
    } else {
      newTab(html, filePath);
    }
    markClean();
    if (filePath) addRecentFile(filePath);
  });

  window.electronAPI.onSaved(({ filePath }) => {
    markClean();
    _updateActiveTab(false, filePath);
    flashSaved('✔ Saved');
    if (filePath) addRecentFile(filePath);
  });

  window.electronAPI.onPrint(() => window.print());
  window.electronAPI.onFind(() => openFindBar(false));
  window.electronAPI.onFindReplace(() => openFindBar(true));
  window.electronAPI.onZoomIn(()    => setZoom(zoomLevel + 10));
  window.electronAPI.onZoomOut(()   => setZoom(zoomLevel - 10));
  window.electronAPI.onZoomReset(() => setZoom(100));
  window.electronAPI.onRulerToggle(toggleRuler);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initFilePanel();
  initPrintPreview();
  initReadingMode();
  initDfMode();
  initHeaderFooter();
  initTableContextMenu();
  initWordTarget();
  initMailMerge();
  initRuler();
  wireButtons();
  initFontControls();
  initColorPickers();
  initPage();
  initSpellCheck();
  initIPC();
  updateStatus();
  const settings = await loadSettings();
  applySettings(settings);
});

// ─── Real Spell Check ─────────────────────────────────────────────────────────

// Common English dictionary — top 50k words subset (most common words)
// Stored as a Set for O(1) lookup
const _DICT_WORDS = new Set(`a able about above absent absolute accept accident account accurate ache achieve across act action active actual add address admit adult advance advice afraid after afternoon again against age ago agree ahead aid aim air airport all allow almost alone along already also although always among amount and angry animal answer any anyone anything appear apply argue arm army around arrive art ask attach attempt attention aunt autumn avoid away
back ball bank bare basic bath battle be bear beautiful because become bed before begin behind believe belong below best better between big bird birth bitter black block blood blow blue board body bomb bone book border born both bottom bought box break breakfast bridge bright bring brother build burn busy but buy
cake calculate call calm came can cancel capital captain card care carry case catch cause celebrate central century change charge check child choose cinema clean clear climb close cloth cloud cold come comfort common connect consider contact continue cook cool count country course cover create crime cross culture cup current cut
dance danger dark date daughter deal dear death decide decide delay deliver depend design detail develop differ difficult dinner discover distance doctor done door double down dream drive dust
each early earn eat edge education effort election email employee encourage end energy enjoy enough enter environment equal escape even event every examine example exercise exist expect explain
face fact fail fall family famous farmer fast father fault fear feel fell fight fill final find fish fix float follow food force forget form found friend from front full fun
game gate gave give glad go good great green group grow guess guide
happy hard have head hear heart held help high hill history home hope hour house how huge human hunt hurry
idea identify if ignore improve include individual inform inside invite island issue it
join judge jump
keep kill kind know
lady land large last late laugh law lead learn leave left less letter life light like list listen live local long look lose loud love lucky lunch
machine main make manage market matter mean meet member middle might mind miss money month more move must
name natural near need never new next night none nor not notice now
object offer office often old once open order other outside over own
pain paper parent part pass patient pay peace people phone place plan play point police poor possible power present price prince problem provide pull push put
question quick quiet
race rain raise reach read real reason receive record red remain remember repeat report result return rich road rule run
safe school science season see seem send serious set share show side sign simple since sister size skill sleep slow small smile someone something song sorry speak special stand start still stop store strange street strong study such suggest summer sure swim
table take talk task teach team think through time today together tomorrow town trade travel tree true trust turn
under until up use usual
very village visit voice wait walk want war water we wear well wide win woman wonder word work world write
year young`.split(/\s+/).filter(w => w.length > 1));

// User's personal dictionary (words added via "Add to Dictionary")
let _userDict = new Set();

// Words to ignore this session
let _ignoredWords = new Set();

// Levenshtein distance for suggestions
function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function _isKnownWord(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w || w.length <= 1) return true;
  if (_userDict.has(w) || _ignoredWords.has(w)) return true;
  if (_DICT_WORDS.has(w)) return true;
  // Allow proper nouns (capitalized) and numbers
  if (/^[A-Z]/.test(word) || /\d/.test(word)) return true;
  return false;
}

function _getSuggestions(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w || w.length < 2) return [];
  const maxDist = w.length <= 4 ? 1 : w.length <= 8 ? 2 : 3;
  const candidates = [];
  // Only check words of similar length (±3) for performance
  for (const dictWord of _DICT_WORDS) {
    if (Math.abs(dictWord.length - w.length) > 3) continue;
    const dist = _levenshtein(w, dictWord);
    if (dist <= maxDist) candidates.push({ word: dictWord, dist });
  }
  // Sort by distance then alphabetically, return top 5
  candidates.sort((a,b) => a.dist - b.dist || a.word.localeCompare(b.word));
  return candidates.slice(0, 5).map(c => c.word);
}

// ── Spell check context menu ──────────────────────────────────────────────────
let _spellCtxWord     = '';
let _spellCtxRange    = null;

function initSpellCheck() {
  const p = page();
  if (!p) return;

  p.addEventListener('contextmenu', (e) => {
    // Only intercept if spell check is on and we right-clicked on a word
    if (!spellOn) return;

    // Don't intercept table cell right-clicks — let table context menu handle those
    if (e.target.closest('td, th')) return;

    const target = e.target;
    if (!target || !p.contains(target)) return;

    // Get the word under the cursor
    const sel   = window.getSelection();
    let   word  = '';
    let   range = null;

    // Try to select the word at click position
    try {
      if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(e.clientX, e.clientY);
      } else if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
        if (pos) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
          range.setEnd(pos.offsetNode, pos.offset);
        }
      }
      if (range) {
        // Expand to word boundaries
        range.expand?.('word');
        if (!range.expand) {
          // Manual word expand fallback
          const node = range.startContainer;
          if (node.nodeType === 3) {
            const text  = node.textContent;
            let   start = range.startOffset;
            let   end   = range.startOffset;
            while (start > 0 && /\w/.test(text[start-1])) start--;
            while (end < text.length && /\w/.test(text[end])) end++;
            range.setStart(node, start);
            range.setEnd(node, end);
          }
        }
        word = range.toString().trim();
      }
    } catch(err) {}

    if (!word || _isKnownWord(word)) return; // Known word — let native menu show

    e.preventDefault();
    _spellCtxWord  = word;
    _spellCtxRange = range;

    const suggestions = _getSuggestions(word);
    _showSpellMenu(e.clientX, e.clientY, word, suggestions);
  });
}

function _showSpellMenu(x, y, word, suggestions) {
  // Remove any existing spell menu
  document.getElementById('spell-ctx-menu')?.remove();

  const menu = document.createElement('div');
  menu.id = 'spell-ctx-menu';
  menu.className = 'spell-ctx-menu';

  let html = `<div class="spell-menu-word">&#10006; "${word}"</div>`;

  if (suggestions.length) {
    html += `<div class="spell-menu-label">Suggestions:</div>`;
    suggestions.forEach(s => {
      html += `<div class="spell-menu-item spell-suggestion" data-word="${s}">${s}</div>`;
    });
  } else {
    html += `<div class="spell-menu-none">No suggestions found</div>`;
  }

  html += `<div class="spell-menu-divider"></div>`;
  html += `<div class="spell-menu-item" id="spell-ignore">Ignore</div>`;
  html += `<div class="spell-menu-item" id="spell-ignore-all">Ignore All</div>`;
  html += `<div class="spell-menu-item" id="spell-add-dict">Add to Dictionary</div>`;

  menu.innerHTML = html;

  // Position menu — keep within viewport
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  document.body.appendChild(menu);

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right  > window.innerWidth)  menu.style.left = (x - rect.width)  + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top  = (y - rect.height) + 'px';
  });

  // Wire suggestion clicks
  menu.querySelectorAll('.spell-suggestion').forEach(el => {
    el.addEventListener('click', () => {
      _replaceSpellWord(el.dataset.word);
      _closeSpellMenu();
    });
  });

  document.getElementById('spell-ignore')?.addEventListener('click', () => {
    _ignoredWords.add(word.toLowerCase());
    _closeSpellMenu();
    flashSaved(`"${word}" ignored`);
  });

  document.getElementById('spell-ignore-all')?.addEventListener('click', () => {
    _ignoredWords.add(word.toLowerCase());
    // Re-trigger spellcheck to clear underline
    const p = page();
    if (p) { p.spellcheck = false; requestAnimationFrame(() => { p.spellcheck = true; }); }
    _closeSpellMenu();
    flashSaved(`"${word}" ignored everywhere`);
  });

  document.getElementById('spell-add-dict')?.addEventListener('click', () => {
    _userDict.add(word.toLowerCase());
    _ignoredWords.add(word.toLowerCase());
    // Persist to settings
    const s = { ..._currentSettings, userDictionary: [..._userDict] };
    saveSettings(s);
    _closeSpellMenu();
    flashSaved(`"${word}" added to dictionary`);
  });

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', _closeSpellMenu, { once: true });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeSpellMenu(); }, { once: true });
  }, 0);
}

function _replaceSpellWord(newWord) {
  if (!_spellCtxRange) return;
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(_spellCtxRange);
    // Preserve capitalisation if original was capitalised
    let replacement = newWord;
    if (_spellCtxWord && /^[A-Z]/.test(_spellCtxWord)) {
      replacement = newWord.charAt(0).toUpperCase() + newWord.slice(1);
    }
    document.execCommand('insertText', false, replacement);
    markModified();
  } catch(e) {}
}

function _closeSpellMenu() {
  document.getElementById('spell-ctx-menu')?.remove();
}
