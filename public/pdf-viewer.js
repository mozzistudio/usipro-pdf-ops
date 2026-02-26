/**
 * PDF Viewer — validation workflow with 3 actions per PDF
 *
 * Per-PDF flow (one at a time):
 *  1. Show side-by-side (Original | Anonymized) from phase 1 data
 *  2. Three actions:
 *     A. ACCEPT — keep anonymized as-is
 *     B. REJECT — draw zones on canvas → /api/anonymize-zone → validate corrected
 *     C. ADD TABLE — drag/drop USI-PRO table overlay on original → /api/add-usipro-table
 *  3. When all validated → window.onAllPdfsValidated(store) called
 */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // { filename: { partId, originalBase64, anonymizedBase64, finalBase64, validated, ofNum } }
  const store = {};
  let _totalCount = 0;
  let _currentIndex = 0;
  let _names = [];

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Initialize viewer with pre-anonymized PDFs from phase 1.
   * @param {Array<{partId, originalBase64, anonymizedBase64}>} pdfs
   * @param {string} ofNum
   */
  window.showPdfViewerFromPhase1 = function (pdfs, ofNum) {
    const section = document.getElementById('pdfSection');
    const container = document.getElementById('pdfCardsContainer');

    section.style.display = 'block';
    container.innerHTML = '';

    _names = pdfs.map(p => p.partId + '.pdf').sort();
    _currentIndex = 0;
    _totalCount = _names.length;

    if (_names.length === 0) {
      container.innerHTML = '<div class="pdf-loading">Aucun plan PDF disponible.</div>';
      updateCounter();
      return;
    }

    // Build store + cards
    pdfs.sort((a, b) => a.partId.localeCompare(b.partId));
    pdfs.forEach((p, i) => {
      const name = p.partId + '.pdf';
      store[name] = {
        partId: p.partId,
        originalBase64: p.originalBase64,
        anonymizedBase64: p.anonymizedBase64,
        finalBase64: null,
        validated: false,
        ofNum,
      };
      const card = buildCard(name);
      card.style.display = i === 0 ? 'block' : 'none';
      container.appendChild(card);
    });

    updateCounter();

    // Render all cards (only first is visible)
    pdfs.forEach(p => {
      const name = p.partId + '.pdf';
      renderSideBySide(name, p.originalBase64, p.anonymizedBase64).then(() => {
        const fid = fkey(name);
        const vbar = document.getElementById('vbar-' + fid);
        if (vbar) vbar.style.display = 'flex';
      });
    });

    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  window.resetPdfViewer = function () {
    const s = document.getElementById('pdfSection');
    if (s) s.style.display = 'none';
    const c = document.getElementById('pdfCardsContainer');
    if (c) c.innerHTML = '';
    Object.keys(store).forEach((k) => delete store[k]);
    _totalCount = 0;
    _currentIndex = 0;
    _names = [];
    updateCounter();
  };

  // ── Counter display ──────────────────────────────────────────────
  function updateCounter() {
    const el = document.getElementById('pdfStepIndicator');
    if (!el) return;
    if (_totalCount === 0) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'inline-block';
    const display = Math.min(_currentIndex + 1, _totalCount);
    el.textContent = `${display} / ${_totalCount}`;
  }

  // ── Show card at _currentIndex ───────────────────────────────────
  function showCurrentCard() {
    _names.forEach((name, i) => {
      const fid = fkey(name);
      const card = document.getElementById('card-' + fid);
      if (card) card.style.display = i === _currentIndex ? 'block' : 'none';
    });
    updateCounter();
    const section = document.getElementById('pdfSection');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Card DOM ────────────────────────────────────────────────────
  function buildCard(name) {
    const fid = fkey(name);
    const card = document.createElement('div');
    card.className = 'pdf-viewer-card';
    card.id = 'card-' + fid;
    card.innerHTML = `
      <div class="pdf-card-header">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
             stroke="rgba(255,255,255,0.45)" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="pdf-card-name">${name}</span>
        <span class="pdf-card-info" id="info-${fid}"></span>
        <span class="pdf-validation-badge" id="badge-${fid}"></span>
      </div>
      <div class="pdf-pages-list" id="pglist-${fid}"></div>
      <div class="pdf-validation-bar" id="vbar-${fid}" style="display:none">
        <button class="btn-validate" onclick="acceptPdf('${name}')">✓ Accepter</button>
        <button class="btn-reject" onclick="rejectPdf('${name}')">✗ Corriger</button>
        <button class="btn-add-table" onclick="addTablePdf('${name}')">+ Table USI-PRO</button>
      </div>
      <div class="pdf-reject-bar" id="rbar-${fid}" style="display:none">
        <p class="reject-hint">Dessinez des rectangles sur les zones à masquer, puis cliquez Appliquer.</p>
        <button class="btn-apply-zones" onclick="applyZones('${name}')">Appliquer les corrections</button>
        <button class="btn-cancel-action" onclick="cancelAction('${name}')">Annuler</button>
      </div>
      <div class="pdf-table-bar" id="tbar-${fid}" style="display:none">
        <p class="table-hint">Positionnez et redimensionnez l'overlay de la table USI-PRO sur le PDF original.</p>
        <div class="table-data-form">
          <label>Désignation: <input type="text" id="tbl-desig-${fid}" placeholder="—"></label>
          <label>Matériau: <input type="text" id="tbl-mat-${fid}" placeholder="—"></label>
          <label>Norme: <input type="text" id="tbl-std-${fid}" placeholder="—"></label>
          <label>Finition: <input type="text" id="tbl-fin-${fid}" placeholder="—"></label>
        </div>
        <button class="btn-apply-table" onclick="applyTable('${name}')">Appliquer la table</button>
        <button class="btn-cancel-action" onclick="cancelAction('${name}')">Annuler</button>
      </div>
      <div class="pdf-confirm-bar" id="cbar-${fid}" style="display:none">
        <button class="btn-validate" onclick="confirmValidation('${name}')">✓ Valider la correction</button>
        <button class="btn-cancel-action" onclick="cancelAction('${name}')">Annuler</button>
      </div>
    `;
    return card;
  }

  // ── ACCEPT ──────────────────────────────────────────────────────
  window.acceptPdf = function (name) {
    if (!store[name]) return;
    store[name].finalBase64 = store[name].anonymizedBase64;
    markValidated(name);
  };

  // ── REJECT (draw zones) ─────────────────────────────────────────
  window.rejectPdf = function (name) {
    if (!store[name]) return;
    const fid = fkey(name);

    // Hide action bar, show reject bar
    hide('vbar-' + fid);
    show('rbar-' + fid);

    // Enable zone drawing on the anonymized canvas
    enableZoneDrawing(name);
  };

  // Zone drawing state
  const zoneState = {};

  function enableZoneDrawing(name) {
    const fid = fkey(name);
    const pgList = document.getElementById('pglist-' + fid);
    if (!pgList) return;

    zoneState[name] = { zones: [], rects: [] };

    // Find all anonymized-side canvases
    const anonCols = pgList.querySelectorAll('.pdf-comparison-col');
    anonCols.forEach(col => {
      if (!col.querySelector('.comparison-label.anonymized')) return;
      const canvas = col.querySelector('canvas');
      if (!canvas) return;

      // Create overlay canvas for drawing
      const wrapper = canvas.parentElement;
      wrapper.style.position = 'relative';

      const overlay = document.createElement('canvas');
      overlay.className = 'zone-overlay';
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;cursor:crosshair;z-index:10;';
      wrapper.appendChild(overlay);

      const ctx = overlay.getContext('2d');
      let drawing = false;
      let startX, startY;

      overlay.addEventListener('mousedown', e => {
        const rect = overlay.getBoundingClientRect();
        const scaleX = overlay.width / rect.width;
        const scaleY = overlay.height / rect.height;
        startX = (e.clientX - rect.left) * scaleX;
        startY = (e.clientY - rect.top) * scaleY;
        drawing = true;
      });

      overlay.addEventListener('mousemove', e => {
        if (!drawing) return;
        const rect = overlay.getBoundingClientRect();
        const scaleX = overlay.width / rect.width;
        const scaleY = overlay.height / rect.height;
        const curX = (e.clientX - rect.left) * scaleX;
        const curY = (e.clientY - rect.top) * scaleY;

        // Redraw all existing zones + current selection
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        drawAllZones(ctx, zoneState[name].zones);
        ctx.fillStyle = 'rgba(231,76,60,0.25)';
        ctx.strokeStyle = 'rgba(231,76,60,0.8)';
        ctx.lineWidth = 2;
        ctx.fillRect(startX, startY, curX - startX, curY - startY);
        ctx.strokeRect(startX, startY, curX - startX, curY - startY);
      });

      overlay.addEventListener('mouseup', e => {
        if (!drawing) return;
        drawing = false;
        const rect = overlay.getBoundingClientRect();
        const scaleX = overlay.width / rect.width;
        const scaleY = overlay.height / rect.height;
        const endX = (e.clientX - rect.left) * scaleX;
        const endY = (e.clientY - rect.top) * scaleY;

        const x = Math.min(startX, endX);
        const y = Math.min(startY, endY);
        const w = Math.abs(endX - startX);
        const h = Math.abs(endY - startY);

        if (w > 5 && h > 5) {
          // Get page index from the entry
          const entry = wrapper.closest('.pdf-page-entry');
          const allEntries = Array.from(pgList.querySelectorAll('.pdf-page-entry'));
          const pageIdx = allEntries.indexOf(entry);

          zoneState[name].zones.push({
            canvasX: x, canvasY: y, canvasW: w, canvasH: h,
            page: pageIdx,
            overlayCanvas: overlay,
          });
        }

        ctx.clearRect(0, 0, overlay.width, overlay.height);
        drawAllZones(ctx, zoneState[name].zones.filter(z => z.overlayCanvas === overlay));
      });
    });
  }

  function drawAllZones(ctx, zones) {
    ctx.fillStyle = 'rgba(231,76,60,0.25)';
    ctx.strokeStyle = 'rgba(231,76,60,0.8)';
    ctx.lineWidth = 2;
    for (const z of zones) {
      ctx.fillRect(z.canvasX, z.canvasY, z.canvasW, z.canvasH);
      ctx.strokeRect(z.canvasX, z.canvasY, z.canvasW, z.canvasH);
    }
  }

  function disableZoneDrawing(name) {
    const fid = fkey(name);
    const pgList = document.getElementById('pglist-' + fid);
    if (!pgList) return;
    pgList.querySelectorAll('.zone-overlay').forEach(o => o.remove());
    delete zoneState[name];
  }

  // ── APPLY ZONES ─────────────────────────────────────────────────
  window.applyZones = async function (name) {
    if (!store[name] || !zoneState[name]) return;
    const fid = fkey(name);

    const zones = zoneState[name].zones;
    if (zones.length === 0) return;

    // Get PDF page dimensions to convert canvas coords → PDF coords
    const pdfB64 = store[name].anonymizedBase64;
    const pdfBytes = Uint8Array.from(atob(pdfB64), c => c.charCodeAt(0));
    const pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;

    const pdfZones = [];
    for (const z of zones) {
      const page = await pdfDoc.getPage(z.page + 1);
      const vp = page.getViewport({ scale: 1 });
      const canvas = z.overlayCanvas;

      const scale = canvas.width / vp.width;
      const pageH = vp.height;

      pdfZones.push({
        page: z.page,
        x: z.canvasX / scale,
        y: pageH - (z.canvasY + z.canvasH) / scale,
        width: z.canvasW / scale,
        height: z.canvasH / scale,
      });
    }

    // Show loading
    const rbar = document.getElementById('rbar-' + fid);
    if (rbar) rbar.innerHTML = '<div class="pdf-loading"><span class="spinner-small"></span>Application des corrections…</div>';

    try {
      const resp = await fetch('/api/anonymize-zone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: pdfB64, zones: pdfZones }),
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const { pdfBase64: correctedB64 } = await resp.json();

      store[name].anonymizedBase64 = correctedB64;
      disableZoneDrawing(name);

      // Re-render side-by-side with corrected version
      await renderSideBySide(name, store[name].originalBase64, correctedB64);

      // Show confirm bar
      hide('rbar-' + fid);
      show('cbar-' + fid);
    } catch (err) {
      console.error('[pdf-viewer] applyZones error:', err);
      if (rbar) rbar.innerHTML = '<div class="pdf-loading" style="color:var(--error)">Erreur: ' + err.message + '</div>';
    }
  };

  // ── ADD TABLE ───────────────────────────────────────────────────
  window.addTablePdf = function (name) {
    if (!store[name]) return;
    const fid = fkey(name);

    hide('vbar-' + fid);
    show('tbar-' + fid);

    // Render original only (full width) and add draggable overlay
    renderOriginalWithOverlay(name);
  };

  async function renderOriginalWithOverlay(name) {
    const fid = fkey(name);
    const pgList = document.getElementById('pglist-' + fid);
    if (!pgList) return;

    const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const origDoc = await pdfjsLib.getDocument({ data: toBytes(store[name].originalBase64) }).promise;

    pgList.innerHTML = '';

    const colW = Math.max(pgList.clientWidth - 40, 400);

    for (let pn = 1; pn <= origDoc.numPages; pn++) {
      const entry = document.createElement('div');
      entry.className = 'pdf-page-entry';
      entry.dataset.pageIndex = String(pn - 1);

      if (origDoc.numPages > 1) {
        const lbl = document.createElement('div');
        lbl.className = 'pdf-page-label';
        lbl.textContent = 'Page ' + pn + ' / ' + origDoc.numPages;
        entry.appendChild(lbl);
      }

      const page = await origDoc.getPage(pn);
      const naturalVP = page.getViewport({ scale: 1 });
      const scale = Math.min(colW / naturalVP.width, 2.0);
      const vp = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.dataset.pdfWidth = String(naturalVP.width);
      canvas.dataset.pdfHeight = String(naturalVP.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

      const wrapper = document.createElement('div');
      wrapper.className = 'canvas-wrapper';
      wrapper.style.position = 'relative';
      wrapper.style.width = canvas.width + 'px';
      wrapper.appendChild(canvas);

      // Add draggable overlay on first page only
      if (pn === 1) {
        const canvasScale = canvas.width / naturalVP.width;
        // Default table size: 540×70 pts (from pdfAnonymizer.ts)
        const overlayW = Math.round(540 * canvasScale);
        const overlayH = Math.round(70 * canvasScale);

        const overlay = document.createElement('div');
        overlay.className = 'usipro-table-overlay';
        overlay.id = 'tableOverlay-' + fid;
        overlay.style.width = overlayW + 'px';
        overlay.style.height = overlayH + 'px';
        overlay.style.left = (canvas.width - overlayW - 20) + 'px';
        overlay.style.top = (canvas.height - overlayH - 20) + 'px';
        overlay.innerHTML = `
          <div class="overlay-label">TABLE USI-PRO</div>
          <div class="resize-handle resize-nw" data-dir="nw"></div>
          <div class="resize-handle resize-ne" data-dir="ne"></div>
          <div class="resize-handle resize-sw" data-dir="sw"></div>
          <div class="resize-handle resize-se" data-dir="se"></div>
        `;

        wrapper.appendChild(overlay);
        makeDraggableResizable(overlay, wrapper);
      }

      entry.appendChild(wrapper);
      pgList.appendChild(entry);
    }
  }

  function makeDraggableResizable(overlay, container) {
    let isDragging = false;
    let isResizing = false;
    let resizeDir = '';
    let startX, startY, startLeft, startTop, startW, startH;

    overlay.addEventListener('mousedown', e => {
      if (e.target.classList.contains('resize-handle')) {
        isResizing = true;
        resizeDir = e.target.dataset.dir;
      } else {
        isDragging = true;
      }
      startX = e.clientX;
      startY = e.clientY;
      startLeft = overlay.offsetLeft;
      startTop = overlay.offsetTop;
      startW = overlay.offsetWidth;
      startH = overlay.offsetHeight;
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!isDragging && !isResizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (isDragging) {
        let newLeft = startLeft + dx;
        let newTop = startTop + dy;
        // Constrain within container
        newLeft = Math.max(0, Math.min(newLeft, container.offsetWidth - overlay.offsetWidth));
        newTop = Math.max(0, Math.min(newTop, container.offsetHeight - overlay.offsetHeight));
        overlay.style.left = newLeft + 'px';
        overlay.style.top = newTop + 'px';
      } else if (isResizing) {
        let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;

        if (resizeDir.includes('e')) newW = Math.max(100, startW + dx);
        if (resizeDir.includes('w')) { newW = Math.max(100, startW - dx); newLeft = startLeft + dx; }
        if (resizeDir.includes('s')) newH = Math.max(40, startH + dy);
        if (resizeDir.includes('n')) { newH = Math.max(40, startH - dy); newTop = startTop + dy; }

        overlay.style.width = newW + 'px';
        overlay.style.height = newH + 'px';
        overlay.style.left = newLeft + 'px';
        overlay.style.top = newTop + 'px';
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      isResizing = false;
    });
  }

  // ── APPLY TABLE ─────────────────────────────────────────────────
  window.applyTable = async function (name) {
    if (!store[name]) return;
    const fid = fkey(name);

    const overlay = document.getElementById('tableOverlay-' + fid);
    if (!overlay) return;

    const wrapper = overlay.parentElement;
    const canvas = wrapper.querySelector('canvas');
    const entry = wrapper.closest('.pdf-page-entry');
    const pageIdx = parseInt(entry.dataset.pageIndex || '0');

    const pdfW = parseFloat(canvas.dataset.pdfWidth);
    const pdfH = parseFloat(canvas.dataset.pdfHeight);
    const canvasScale = canvas.width / pdfW;

    // Convert overlay position from canvas coords to PDF coords
    const canvasX = overlay.offsetLeft;
    const canvasY = overlay.offsetTop;
    const canvasW = overlay.offsetWidth;
    const canvasH = overlay.offsetHeight;

    const zone = {
      page: pageIdx,
      x: canvasX / canvasScale,
      y: pdfH - (canvasY + canvasH) / canvasScale,
      width: canvasW / canvasScale,
      height: canvasH / canvasScale,
    };

    const cartoucheData = {
      designation: document.getElementById('tbl-desig-' + fid)?.value || '—',
      material: document.getElementById('tbl-mat-' + fid)?.value || '—',
      applicableStd: document.getElementById('tbl-std-' + fid)?.value || '—',
      finish: document.getElementById('tbl-fin-' + fid)?.value || '—',
    };

    const partId = store[name].partId;
    const tbar = document.getElementById('tbar-' + fid);
    if (tbar) tbar.innerHTML = '<div class="pdf-loading"><span class="spinner-small"></span>Application de la table…</div>';

    try {
      const resp = await fetch('/api/add-usipro-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfBase64: store[name].originalBase64,
          planId: partId,
          lotId: store[name].ofNum,
          zone,
          cartoucheData,
        }),
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const { pdfBase64: modifiedB64 } = await resp.json();

      store[name].anonymizedBase64 = modifiedB64;

      // Re-render side-by-side: Original | Modified
      await renderSideBySide(name, store[name].originalBase64, modifiedB64);

      hide('tbar-' + fid);
      show('cbar-' + fid);
    } catch (err) {
      console.error('[pdf-viewer] applyTable error:', err);
      if (tbar) tbar.innerHTML = '<div class="pdf-loading" style="color:var(--error)">Erreur: ' + err.message + '</div>';
    }
  };

  // ── CONFIRM VALIDATION (after reject/add-table corrections) ────
  window.confirmValidation = function (name) {
    if (!store[name]) return;
    store[name].finalBase64 = store[name].anonymizedBase64;
    markValidated(name);
  };

  // ── CANCEL ACTION ───────────────────────────────────────────────
  window.cancelAction = function (name) {
    if (!store[name]) return;
    const fid = fkey(name);

    disableZoneDrawing(name);

    // Re-render original side-by-side
    const origAnon = store[name].anonymizedBase64;
    renderSideBySide(name, store[name].originalBase64, origAnon).then(() => {
      hide('rbar-' + fid);
      hide('tbar-' + fid);
      hide('cbar-' + fid);
      show('vbar-' + fid);
    });
  };

  // ── Mark as validated and advance ───────────────────────────────
  function markValidated(name) {
    store[name].validated = true;
    const fid = fkey(name);

    const card = document.getElementById('card-' + fid);
    if (card) card.classList.add('pdf-card-validated');

    const badge = document.getElementById('badge-' + fid);
    if (badge) { badge.textContent = '✓ Validé'; badge.className = 'pdf-validation-badge validated'; }

    // Hide all action bars, show validated label
    ['vbar', 'rbar', 'tbar', 'cbar'].forEach(bar => hide(bar + '-' + fid));
    const vbar = document.getElementById('vbar-' + fid);
    if (vbar) {
      vbar.innerHTML = '<span class="validated-label">✓ PDF validé</span>';
      vbar.style.display = 'flex';
    }

    // Advance to next
    if (_currentIndex < _totalCount - 1) {
      _currentIndex++;
      showCurrentCard();
    } else {
      updateCounter();
    }

    checkAllValidated();
  }

  // ── Check if all PDFs are validated ─────────────────────────────
  function checkAllValidated() {
    const total = _totalCount;
    const validated = Object.values(store).filter((s) => s.validated).length;
    if (total > 0 && validated >= total) {
      if (typeof window.onAllPdfsValidated === 'function') {
        window.onAllPdfsValidated(store);
      }
    }
  }

  // ── Render side-by-side: original | anonymized ──────────────────
  async function renderSideBySide(name, originalBase64, anonymizedBase64) {
    const fid = fkey(name);
    const pgList = document.getElementById('pglist-' + fid);
    if (!pgList) return;

    const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

    const [origDoc, anonDoc] = await Promise.all([
      pdfjsLib.getDocument({ data: toBytes(originalBase64) }).promise,
      pdfjsLib.getDocument({ data: toBytes(anonymizedBase64) }).promise,
    ]);

    const infoEl = document.getElementById('info-' + fid);
    if (infoEl) {
      const pages = anonDoc.numPages + ' page' + (anonDoc.numPages > 1 ? 's' : '');
      infoEl.textContent = pages;
    }

    pgList.innerHTML = '';

    const numPages = Math.max(origDoc.numPages, anonDoc.numPages);
    const colW = Math.max((pgList.clientWidth - 60) / 2, 240);

    for (let pn = 1; pn <= numPages; pn++) {
      const entry = document.createElement('div');
      entry.className = 'pdf-page-entry';
      entry.dataset.pageIndex = String(pn - 1);

      if (numPages > 1) {
        const lbl = document.createElement('div');
        lbl.className = 'pdf-page-label';
        lbl.textContent = 'Page ' + pn + ' / ' + numPages;
        entry.appendChild(lbl);
      }

      const comparison = document.createElement('div');
      comparison.className = 'pdf-comparison';

      if (pn <= origDoc.numPages) {
        const col = document.createElement('div');
        col.className = 'pdf-comparison-col';
        const lbl = document.createElement('div');
        lbl.className = 'comparison-label original';
        lbl.textContent = 'Original';
        col.appendChild(lbl);
        const page = await origDoc.getPage(pn);
        col.appendChild(wrapCanvas(await renderPage(page, colW)));
        comparison.appendChild(col);
      }

      if (pn <= anonDoc.numPages) {
        const col = document.createElement('div');
        col.className = 'pdf-comparison-col';
        const lbl = document.createElement('div');
        lbl.className = 'comparison-label anonymized';
        lbl.textContent = 'Anonymisé';
        col.appendChild(lbl);
        const page = await anonDoc.getPage(pn);
        col.appendChild(wrapCanvas(await renderPage(page, colW)));
        comparison.appendChild(col);
      }

      entry.appendChild(comparison);
      pgList.appendChild(entry);
    }
  }

  async function renderPage(page, availW) {
    const naturalVP = page.getViewport({ scale: 1 });
    const scale = Math.min(availW / naturalVP.width, 2.0);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.dataset.pdfWidth = String(naturalVP.width);
    canvas.dataset.pdfHeight = String(naturalVP.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return canvas;
  }

  function wrapCanvas(canvas) {
    const wrapper = document.createElement('div');
    wrapper.className = 'canvas-wrapper';
    wrapper.style.width = canvas.width + 'px';
    wrapper.appendChild(canvas);
    return wrapper;
  }

  // ── Download ────────────────────────────────────────────────────
  window.downloadPdf = function (name) {
    const s = store[name];
    if (!s) return;
    const b64 = s.finalBase64 || s.anonymizedBase64;
    if (!b64) return;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Helpers ────────────────────────────────────────────────────
  function fkey(name) {
    return 'pv_' + name.replace(/[^a-zA-Z0-9]/g, '_');
  }

  function show(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  }

  function hide(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
})();
