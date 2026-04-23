/**
 * PDF Viewer — Page-by-page validation workflow with AI correction mode
 *
 * Flow:
 *  1. Show pages one at a time (side-by-side Original | Anonymized)
 *  2. Per-page actions:
 *     A. ACCEPT — keep anonymized page as-is
 *     B. CORRIGER — open fullscreen correction mode (draw zones + AI prompt)
 *     C. ADD TABLE — drag/drop USI-PRO table overlay on original page
 *  3. Navigate between pages with Prev/Next
 *  4. Counter: "3 / 8 pages validées"
 *  5. When all pages validated → window.onAllPdfsValidated(store)
 */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // ── State ──────────────────────────────────────────────────────
  // store[filename] = { partId, originalBase64, anonymizedBase64, ofNum, pages: [] }
  // pages[i] = { validated, correctedBase64 }
  const store = {};
  let _allPages = []; // flat list: [{ filename, pageIndex, totalPages }]
  let _currentPageIdx = 0;

  // ── Public API ─────────────────────────────────────────────────

  window.showPdfViewerFromPhase1 = function (pdfs, ofNum) {
    const section = document.getElementById('pdfSection');
    const container = document.getElementById('pdfCardsContainer');

    section.style.display = 'block';
    container.innerHTML = '';

    // Reset state
    Object.keys(store).forEach(k => delete store[k]);
    _allPages = [];
    _currentPageIdx = 0;

    if (pdfs.length === 0) {
      container.innerHTML = '<div class="pdf-loading">Aucun plan PDF disponible.</div>';
      updateCounter();
      return;
    }

    // Build store entries (page counts filled async)
    pdfs.sort((a, b) => a.partId.localeCompare(b.partId));
    const loadPromises = pdfs.map(async (p) => {
      const name = p.partId + '.pdf';
      const bytes = Uint8Array.from(atob(p.anonymizedBase64), c => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      const numPages = doc.numPages;

      store[name] = {
        partId: p.partId,
        originalBase64: p.originalBase64,
        anonymizedBase64: p.anonymizedBase64,
        ofNum,
        pages: Array.from({ length: numPages }, () => ({ validated: false, correctedBase64: null })),
      };

      for (let i = 0; i < numPages; i++) {
        _allPages.push({ filename: name, pageIndex: i, totalPages: numPages });
      }
    });

    Promise.all(loadPromises).then(() => {
      // Sort: by filename then page index
      _allPages.sort((a, b) => a.filename.localeCompare(b.filename) || a.pageIndex - b.pageIndex);
      _currentPageIdx = 0;
      renderCurrentPage();
      updateCounter();
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  window.resetPdfViewer = function () {
    const s = document.getElementById('pdfSection');
    if (s) s.style.display = 'none';
    const c = document.getElementById('pdfCardsContainer');
    if (c) c.innerHTML = '';
    Object.keys(store).forEach(k => delete store[k]);
    _allPages = [];
    _currentPageIdx = 0;
    updateCounter();
    closeCorrectionMode();
  };

  // ── Counter ────────────────────────────────────────────────────

  function updateCounter() {
    const el = document.getElementById('pdfStepIndicator');
    if (!el) return;
    if (_allPages.length === 0) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'inline-block';
    const validatedCount = countValidated();
    el.textContent = `${validatedCount} / ${_allPages.length} pages validées`;
  }

  function countValidated() {
    let count = 0;
    for (const name of Object.keys(store)) {
      for (const pg of store[name].pages) {
        if (pg.validated) count++;
      }
    }
    return count;
  }

  // ── Page rendering ─────────────────────────────────────────────

  async function renderCurrentPage() {
    const container = document.getElementById('pdfCardsContainer');
    if (!container || _allPages.length === 0) return;

    const entry = _allPages[_currentPageIdx];
    if (!entry) return;

    const s = store[entry.filename];
    if (!s) return;

    container.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'pdf-viewer-card';

    // Header
    const header = document.createElement('div');
    header.className = 'pdf-card-header';
    header.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
           stroke="rgba(255,255,255,0.45)" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="pdf-card-name">${entry.filename}</span>
      <span class="pdf-card-info">Page ${entry.pageIndex + 1} / ${entry.totalPages}</span>
      <span class="pdf-validation-badge ${s.pages[entry.pageIndex].validated ? 'validated' : ''}"
        >${s.pages[entry.pageIndex].validated ? '✓ Validée' : ''}</span>
    `;
    card.appendChild(header);

    // Pages list (single page, side-by-side)
    const pgList = document.createElement('div');
    pgList.className = 'pdf-pages-list';
    card.appendChild(pgList);

    // Render side-by-side for this single page
    const toBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const anonB64 = s.pages[entry.pageIndex].correctedBase64 || s.anonymizedBase64;

    const [origDoc, anonDoc] = await Promise.all([
      pdfjsLib.getDocument({ data: toBytes(s.originalBase64) }).promise,
      pdfjsLib.getDocument({ data: toBytes(anonB64) }).promise,
    ]);

    const pageEntry = document.createElement('div');
    pageEntry.className = 'pdf-page-entry';
    pageEntry.dataset.pageIndex = String(entry.pageIndex);

    const comparison = document.createElement('div');
    comparison.className = 'pdf-comparison';
    const colW = Math.max((pgList.clientWidth || 1000) / 2 - 30, 360);

    // Original side
    if (entry.pageIndex < origDoc.numPages) {
      const col = document.createElement('div');
      col.className = 'pdf-comparison-col';
      const lbl = document.createElement('div');
      lbl.className = 'comparison-label original';
      lbl.textContent = 'Original';
      col.appendChild(lbl);
      const page = await origDoc.getPage(entry.pageIndex + 1);
      col.appendChild(wrapCanvas(await renderPage(page, colW)));
      comparison.appendChild(col);
    }

    // Anonymized side
    if (entry.pageIndex < anonDoc.numPages) {
      const col = document.createElement('div');
      col.className = 'pdf-comparison-col';
      const lbl = document.createElement('div');
      lbl.className = 'comparison-label anonymized';
      lbl.textContent = 'Anonymisé';
      col.appendChild(lbl);
      const page = await anonDoc.getPage(entry.pageIndex + 1);
      col.appendChild(wrapCanvas(await renderPage(page, colW)));
      comparison.appendChild(col);
    }

    pageEntry.appendChild(comparison);
    pgList.appendChild(pageEntry);

    // Action bars
    const isValidated = s.pages[entry.pageIndex].validated;

    if (isValidated) {
      const vbar = document.createElement('div');
      vbar.className = 'pdf-validation-bar';
      vbar.style.display = 'flex';
      vbar.innerHTML = '<span class="validated-label">✓ Page validée</span>';
      card.appendChild(vbar);
    } else {
      const vbar = document.createElement('div');
      vbar.className = 'pdf-validation-bar';
      vbar.style.display = 'flex';
      vbar.innerHTML = `
        <button class="btn-validate" id="btnAcceptPage">✓ Accepter</button>
        <button class="btn-reject" id="btnCorrectPage">✗ Corriger</button>
        <button class="btn-add-table" id="btnAddTablePage">+ Table USI-PRO</button>
      `;
      card.appendChild(vbar);
    }

    // Navigation bar
    const nav = document.createElement('div');
    nav.className = 'pdf-validation-bar';
    nav.style.display = 'flex';
    nav.style.justifyContent = 'space-between';
    nav.style.borderTop = '1px solid rgba(255,255,255,0.06)';
    nav.style.marginTop = '0';
    nav.innerHTML = `
      <button class="btn-cancel-action" id="btnPrevPage" ${_currentPageIdx === 0 ? 'disabled' : ''}>&#8592; Précédent</button>
      <button class="btn-cancel-action" id="btnNextPage" ${_currentPageIdx >= _allPages.length - 1 ? 'disabled' : ''}>Suivant &#8594;</button>
    `;
    card.appendChild(nav);

    container.appendChild(card);

    // Bind events
    const btnAccept = document.getElementById('btnAcceptPage');
    const btnCorrect = document.getElementById('btnCorrectPage');
    const btnAddTable = document.getElementById('btnAddTablePage');
    const btnPrev = document.getElementById('btnPrevPage');
    const btnNext = document.getElementById('btnNextPage');

    if (btnAccept) btnAccept.onclick = () => acceptCurrentPage();
    if (btnCorrect) btnCorrect.onclick = () => openCorrectionMode();
    if (btnAddTable) btnAddTable.onclick = () => openAddTableMode();
    if (btnPrev) btnPrev.onclick = () => { _currentPageIdx--; renderCurrentPage(); updateCounter(); };
    if (btnNext) btnNext.onclick = () => { _currentPageIdx++; renderCurrentPage(); updateCounter(); };
  }

  // ── Accept current page ────────────────────────────────────────

  function acceptCurrentPage() {
    const entry = _allPages[_currentPageIdx];
    if (!entry) return;
    const s = store[entry.filename];
    if (!s) return;

    s.pages[entry.pageIndex].validated = true;
    // If no correction was made, keep anonymized as-is
    if (!s.pages[entry.pageIndex].correctedBase64) {
      s.pages[entry.pageIndex].correctedBase64 = null; // will use anonymizedBase64
    }

    advanceAfterValidation();
  }

  function advanceAfterValidation() {
    updateCounter();

    // Check if all done
    if (checkAllValidated()) return;

    // Move to next unvalidated page
    const startIdx = _currentPageIdx;
    for (let i = 1; i <= _allPages.length; i++) {
      const idx = (startIdx + i) % _allPages.length;
      const e = _allPages[idx];
      if (!store[e.filename].pages[e.pageIndex].validated) {
        _currentPageIdx = idx;
        renderCurrentPage();
        return;
      }
    }

    // All validated (shouldn't reach here normally)
    renderCurrentPage();
  }

  function checkAllValidated() {
    const total = _allPages.length;
    const validated = countValidated();
    if (total > 0 && validated >= total) {
      // Build final store for onAllPdfsValidated
      const finalStore = {};
      for (const [name, s] of Object.entries(store)) {
        // Rebuild final PDF from page corrections
        finalStore[name] = {
          partId: s.partId,
          originalBase64: s.originalBase64,
          anonymizedBase64: s.anonymizedBase64,
          finalBase64: s.anonymizedBase64, // default to anonymized
          validated: true,
          ofNum: s.ofNum,
        };

        // If any page has corrections, we need to assemble
        const hasCorrections = s.pages.some(p => p.correctedBase64);
        if (hasCorrections) {
          // For now, use the last corrected full PDF if available
          // The corrections are applied to the full PDF on the server side
          const lastCorrected = [...s.pages].reverse().find(p => p.correctedBase64);
          if (lastCorrected) {
            finalStore[name].finalBase64 = lastCorrected.correctedBase64;
          }
        }
      }

      if (typeof window.onAllPdfsValidated === 'function') {
        window.onAllPdfsValidated(finalStore);
      }
      return true;
    }
    return false;
  }

  // ── Correction mode (fullscreen) ──────────────────────────────

  let _correctionZones = [];
  let _correctionOverlay = null;

  function openCorrectionMode() {
    const entry = _allPages[_currentPageIdx];
    if (!entry) return;
    const s = store[entry.filename];
    if (!s) return;

    _correctionZones = [];

    // Create fullscreen overlay
    const overlay = document.createElement('div');
    overlay.className = 'correction-overlay';
    overlay.id = 'correctionOverlay';

    overlay.innerHTML = `
      <div class="correction-topbar">
        <button class="correction-back-btn" id="corrBackBtn">&#8592; Retour</button>
        <span class="correction-title">${entry.filename} — Page ${entry.pageIndex + 1}</span>
        <span class="correction-page-info">Mode correction</span>
      </div>
      <div class="correction-body">
        <div class="correction-canvas-area" id="corrCanvasArea"></div>
        <div class="correction-panel">
          <div class="correction-panel-header">
            <h3>Zones de correction</h3>
            <p>Dessinez des rectangles sur les zones problématiques</p>
          </div>
          <div class="correction-zones-list" id="corrZonesList">
            <div class="correction-zones-empty">Aucune zone sélectionnée. Dessinez sur le PDF.</div>
          </div>
          <div class="correction-prompt-area">
            <label for="corrPrompt">Prompt de correction (optionnel)</label>
            <textarea id="corrPrompt" placeholder="Ex: Le nom ALPHANOV est encore visible en bas à droite..."></textarea>
          </div>
          <div class="correction-actions">
            <button class="correction-btn-submit" id="corrSubmitBtn">Appliquer les corrections</button>
            <button class="correction-btn-clear" id="corrClearBtn">Effacer les zones</button>
          </div>
          <div class="correction-ai-result" id="corrAiResult" style="display:none"></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    _correctionOverlay = overlay;

    // Render the anonymized page large in the canvas area
    renderCorrectionCanvas(entry, s);

    // Bind events
    document.getElementById('corrBackBtn').onclick = () => closeCorrectionMode();
    document.getElementById('corrSubmitBtn').onclick = () => submitCorrection();
    document.getElementById('corrClearBtn').onclick = () => clearCorrectionZones();
  }

  async function renderCorrectionCanvas(entry, s) {
    const area = document.getElementById('corrCanvasArea');
    if (!area) return;

    const anonB64 = s.pages[entry.pageIndex].correctedBase64 || s.anonymizedBase64;
    const bytes = Uint8Array.from(atob(anonB64), c => c.charCodeAt(0));
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await doc.getPage(entry.pageIndex + 1);

    const naturalVP = page.getViewport({ scale: 1 });
    const maxW = Math.min(area.clientWidth - 48, 1200);
    const scale = Math.min(maxW / naturalVP.width, 3.0);
    const vp = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.dataset.pdfWidth = String(naturalVP.width);
    canvas.dataset.pdfHeight = String(naturalVP.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const wrapper = document.createElement('div');
    wrapper.className = 'correction-canvas-wrapper';
    wrapper.style.width = canvas.width + 'px';
    wrapper.appendChild(canvas);

    // Overlay for zone drawing
    const zoneCanvas = document.createElement('canvas');
    zoneCanvas.className = 'zone-overlay';
    zoneCanvas.width = canvas.width;
    zoneCanvas.height = canvas.height;
    wrapper.appendChild(zoneCanvas);

    area.innerHTML = '';
    area.appendChild(wrapper);

    // Enable drawing
    enableCorrectionDrawing(zoneCanvas, canvas);
  }

  function enableCorrectionDrawing(zoneCanvas, pdfCanvas) {
    const ctx = zoneCanvas.getContext('2d');
    let drawing = false;
    let startX, startY;

    zoneCanvas.addEventListener('mousedown', e => {
      const rect = zoneCanvas.getBoundingClientRect();
      const scaleX = zoneCanvas.width / rect.width;
      const scaleY = zoneCanvas.height / rect.height;
      startX = (e.clientX - rect.left) * scaleX;
      startY = (e.clientY - rect.top) * scaleY;
      drawing = true;
    });

    zoneCanvas.addEventListener('mousemove', e => {
      if (!drawing) return;
      const rect = zoneCanvas.getBoundingClientRect();
      const scaleX = zoneCanvas.width / rect.width;
      const scaleY = zoneCanvas.height / rect.height;
      const curX = (e.clientX - rect.left) * scaleX;
      const curY = (e.clientY - rect.top) * scaleY;

      ctx.clearRect(0, 0, zoneCanvas.width, zoneCanvas.height);
      drawCorrectionZones(ctx);
      ctx.fillStyle = 'rgba(231,76,60,0.25)';
      ctx.strokeStyle = 'rgba(231,76,60,0.8)';
      ctx.lineWidth = 2;
      ctx.fillRect(startX, startY, curX - startX, curY - startY);
      ctx.strokeRect(startX, startY, curX - startX, curY - startY);
    });

    zoneCanvas.addEventListener('mouseup', e => {
      if (!drawing) return;
      drawing = false;
      const rect = zoneCanvas.getBoundingClientRect();
      const scaleX = zoneCanvas.width / rect.width;
      const scaleY = zoneCanvas.height / rect.height;
      const endX = (e.clientX - rect.left) * scaleX;
      const endY = (e.clientY - rect.top) * scaleY;

      const x = Math.min(startX, endX);
      const y = Math.min(startY, endY);
      const w = Math.abs(endX - startX);
      const h = Math.abs(endY - startY);

      if (w > 5 && h > 5) {
        // Convert to percent of canvas
        _correctionZones.push({
          x_percent: x / zoneCanvas.width,
          y_percent: y / zoneCanvas.height,
          width_percent: w / zoneCanvas.width,
          height_percent: h / zoneCanvas.height,
          canvasX: x,
          canvasY: y,
          canvasW: w,
          canvasH: h,
        });
        updateCorrectionZonesList();
      }

      ctx.clearRect(0, 0, zoneCanvas.width, zoneCanvas.height);
      drawCorrectionZones(ctx);
    });
  }

  function drawCorrectionZones(ctx) {
    ctx.fillStyle = 'rgba(231,76,60,0.25)';
    ctx.strokeStyle = 'rgba(231,76,60,0.8)';
    ctx.lineWidth = 2;
    for (const z of _correctionZones) {
      ctx.fillRect(z.canvasX, z.canvasY, z.canvasW, z.canvasH);
      ctx.strokeRect(z.canvasX, z.canvasY, z.canvasW, z.canvasH);
    }
  }

  function updateCorrectionZonesList() {
    const list = document.getElementById('corrZonesList');
    if (!list) return;

    if (_correctionZones.length === 0) {
      list.innerHTML = '<div class="correction-zones-empty">Aucune zone sélectionnée. Dessinez sur le PDF.</div>';
      return;
    }

    list.innerHTML = _correctionZones.map((z, i) => `
      <div class="correction-zone-item">
        <span class="zone-color"></span>
        <span class="zone-label">Zone ${i + 1} — ${(z.width_percent * 100).toFixed(0)}% x ${(z.height_percent * 100).toFixed(0)}%</span>
        <button class="zone-remove" data-idx="${i}" title="Supprimer">&times;</button>
      </div>
    `).join('');

    list.querySelectorAll('.zone-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        _correctionZones.splice(idx, 1);
        updateCorrectionZonesList();
        // Redraw canvas zones
        const zoneCanvas = document.querySelector('#corrCanvasArea .zone-overlay');
        if (zoneCanvas) {
          const ctx = zoneCanvas.getContext('2d');
          ctx.clearRect(0, 0, zoneCanvas.width, zoneCanvas.height);
          drawCorrectionZones(ctx);
        }
      });
    });
  }

  function clearCorrectionZones() {
    _correctionZones = [];
    updateCorrectionZonesList();
    const zoneCanvas = document.querySelector('#corrCanvasArea .zone-overlay');
    if (zoneCanvas) {
      const ctx = zoneCanvas.getContext('2d');
      ctx.clearRect(0, 0, zoneCanvas.width, zoneCanvas.height);
    }
  }

  async function submitCorrection() {
    const entry = _allPages[_currentPageIdx];
    if (!entry) return;
    const s = store[entry.filename];
    if (!s) return;

    if (_correctionZones.length === 0) return;

    const prompt = document.getElementById('corrPrompt')?.value || '';
    const submitBtn = document.getElementById('corrSubmitBtn');
    const actionsDiv = submitBtn?.parentElement;

    // Show loading
    if (actionsDiv) {
      actionsDiv.innerHTML = '<div class="correction-loading"><span class="spinner-small"></span>Correction en cours...</div>';
    }

    const zones = _correctionZones.map(z => ({
      x_percent: z.x_percent,
      y_percent: z.y_percent,
      width_percent: z.width_percent,
      height_percent: z.height_percent,
    }));

    const pdfB64 = s.pages[entry.pageIndex].correctedBase64 || s.anonymizedBase64;

    try {
      const resp = await fetch('/api/correct-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfBase64: pdfB64,
          pageIndex: entry.pageIndex,
          zones,
          prompt: prompt || undefined,
        }),
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const result = await resp.json();

      // Store corrected PDF
      s.pages[entry.pageIndex].correctedBase64 = result.pdfBase64;

      // Show AI result
      const aiResult = document.getElementById('corrAiResult');
      if (aiResult && result.analysis) {
        aiResult.style.display = 'block';
        let html = `<div class="ai-analysis">${result.analysis}</div>`;
        if (result.corrections && result.corrections.length > 0) {
          html += '<ul class="ai-corrections-list">';
          result.corrections.forEach(c => {
            html += `<li><strong>${c.type}</strong>: ${c.description}</li>`;
          });
          html += '</ul>';
        }
        aiResult.innerHTML = html;
      }

      // Restore actions
      if (actionsDiv) {
        actionsDiv.innerHTML = `
          <button class="correction-btn-submit" id="corrValidateBtn" style="background: linear-gradient(135deg, #27ae60 0%, #1e8449 100%)">✓ Valider cette page</button>
          <button class="correction-btn-clear" id="corrRetryBtn">Recommencer</button>
        `;
        document.getElementById('corrValidateBtn').onclick = () => {
          s.pages[entry.pageIndex].validated = true;
          closeCorrectionMode();
          advanceAfterValidation();
        };
        document.getElementById('corrRetryBtn').onclick = () => {
          // Reset and re-render
          _correctionZones = [];
          updateCorrectionZonesList();
          const area = document.getElementById('corrCanvasArea');
          if (area) renderCorrectionCanvas(entry, s);
          actionsDiv.innerHTML = `
            <button class="correction-btn-submit" id="corrSubmitBtn">Appliquer les corrections</button>
            <button class="correction-btn-clear" id="corrClearBtn">Effacer les zones</button>
          `;
          document.getElementById('corrSubmitBtn').onclick = () => submitCorrection();
          document.getElementById('corrClearBtn').onclick = () => clearCorrectionZones();
          if (aiResult) aiResult.style.display = 'none';
        };
      }

      // Re-render canvas with corrected version
      renderCorrectionCanvas(entry, s);
    } catch (err) {
      console.error('[pdf-viewer] submitCorrection error:', err);
      if (actionsDiv) {
        actionsDiv.innerHTML = `
          <div style="color: #e74c3c; padding: 12px; font-size: 13px;">Erreur: ${err.message}</div>
          <button class="correction-btn-submit" id="corrSubmitBtn">Réessayer</button>
          <button class="correction-btn-clear" id="corrClearBtn">Effacer les zones</button>
        `;
        document.getElementById('corrSubmitBtn').onclick = () => submitCorrection();
        document.getElementById('corrClearBtn').onclick = () => clearCorrectionZones();
      }
    }
  }

  function closeCorrectionMode() {
    const overlay = document.getElementById('correctionOverlay');
    if (overlay) overlay.remove();
    _correctionOverlay = null;
    _correctionZones = [];
    renderCurrentPage();
    updateCounter();
  }

  // ── Add Table mode ─────────────────────────────────────────────

  async function openAddTableMode() {
    const entry = _allPages[_currentPageIdx];
    if (!entry) return;
    const s = store[entry.filename];
    if (!s) return;

    const container = document.getElementById('pdfCardsContainer');
    if (!container) return;

    // Re-render current card with add-table UI
    container.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'pdf-viewer-card';

    // Header
    const header = document.createElement('div');
    header.className = 'pdf-card-header';
    header.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
           stroke="rgba(255,255,255,0.45)" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="pdf-card-name">${entry.filename} — Page ${entry.pageIndex + 1}</span>
      <span class="pdf-card-info">Mode table USI-PRO</span>
    `;
    card.appendChild(header);

    // Render original page with draggable overlay
    const pgList = document.createElement('div');
    pgList.className = 'pdf-pages-list';
    card.appendChild(pgList);

    const toBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const origDoc = await pdfjsLib.getDocument({ data: toBytes(s.originalBase64) }).promise;
    const pageNum = Math.min(entry.pageIndex + 1, origDoc.numPages);
    const page = await origDoc.getPage(pageNum);

    const naturalVP = page.getViewport({ scale: 1 });
    const colW = Math.max((pgList.clientWidth || 800) - 40, 400);
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

    // Draggable table overlay
    const canvasScale = canvas.width / naturalVP.width;
    const overlayW = Math.round(540 * canvasScale);
    const overlayH = Math.round(70 * canvasScale);

    const overlay = document.createElement('div');
    overlay.className = 'usipro-table-overlay';
    overlay.id = 'tableOverlayPage';
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

    const pageEntry = document.createElement('div');
    pageEntry.className = 'pdf-page-entry';
    pageEntry.dataset.pageIndex = String(entry.pageIndex);
    pageEntry.appendChild(wrapper);
    pgList.appendChild(pageEntry);

    // Table data form + actions
    const tbar = document.createElement('div');
    tbar.className = 'pdf-table-bar';
    tbar.style.display = 'block';
    tbar.innerHTML = `
      <p class="table-hint">Positionnez et redimensionnez l'overlay de la table USI-PRO.</p>
      <div class="table-data-form">
        <label>Désignation: <input type="text" id="tblDesigPage" placeholder="—"></label>
        <label>Matériau: <input type="text" id="tblMatPage" placeholder="—"></label>
        <label>Norme: <input type="text" id="tblStdPage" placeholder="—"></label>
        <label>Finition: <input type="text" id="tblFinPage" placeholder="—"></label>
      </div>
      <button class="btn-apply-table" id="btnApplyTablePage">Appliquer la table</button>
      <button class="btn-cancel-action" id="btnCancelTablePage">Annuler</button>
    `;
    card.appendChild(tbar);

    container.appendChild(card);

    // Bind events
    document.getElementById('btnApplyTablePage').onclick = () => applyTableForPage(entry, s);
    document.getElementById('btnCancelTablePage').onclick = () => { renderCurrentPage(); updateCounter(); };
  }

  async function applyTableForPage(entry, s) {
    const overlay = document.getElementById('tableOverlayPage');
    if (!overlay) return;

    const wrapper = overlay.parentElement;
    const canvas = wrapper.querySelector('canvas');

    const pdfW = parseFloat(canvas.dataset.pdfWidth);
    const pdfH = parseFloat(canvas.dataset.pdfHeight);
    const canvasScale = canvas.width / pdfW;

    const zone = {
      page: entry.pageIndex,
      x: overlay.offsetLeft / canvasScale,
      y: pdfH - (overlay.offsetTop + overlay.offsetHeight) / canvasScale,
      width: overlay.offsetWidth / canvasScale,
      height: overlay.offsetHeight / canvasScale,
    };

    const cartoucheData = {
      designation: document.getElementById('tblDesigPage')?.value || '—',
      material: document.getElementById('tblMatPage')?.value || '—',
      applicableStd: document.getElementById('tblStdPage')?.value || '—',
      finish: document.getElementById('tblFinPage')?.value || '—',
    };

    const tbar = overlay.closest('.pdf-viewer-card')?.querySelector('.pdf-table-bar');
    if (tbar) tbar.innerHTML = '<div class="pdf-loading"><span class="spinner-small"></span>Application de la table...</div>';

    try {
      const resp = await fetch('/api/add-usipro-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfBase64: s.originalBase64,
          planId: s.partId,
          lotId: s.ofNum,
          zone,
          cartoucheData,
        }),
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const { pdfBase64: modifiedB64 } = await resp.json();

      // Store as corrected for this page
      s.pages[entry.pageIndex].correctedBase64 = modifiedB64;
      s.pages[entry.pageIndex].validated = true;

      advanceAfterValidation();
    } catch (err) {
      console.error('[pdf-viewer] applyTableForPage error:', err);
      if (tbar) tbar.innerHTML = '<div class="pdf-loading" style="color:var(--error)">Erreur: ' + err.message + '</div>';
    }
  }

  // ── Draggable/Resizable helper ─────────────────────────────────

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

  // ── Render helpers ─────────────────────────────────────────────

  async function renderPage(page, availW) {
    const naturalVP = page.getViewport({ scale: 1 });
    const displayScale = Math.min(availW / naturalVP.width, 4.0);
    const renderScale = Math.max(displayScale, 2.5);
    const vp = page.getViewport({ scale: renderScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.dataset.pdfWidth = String(naturalVP.width);
    canvas.dataset.pdfHeight = String(naturalVP.height);
    // Store display dimensions for CSS sizing
    const displayW = Math.round(naturalVP.width * displayScale);
    const displayH = Math.round(naturalVP.height * displayScale);
    canvas.dataset.displayWidth = String(displayW);
    canvas.dataset.displayHeight = String(displayH);
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return canvas;
  }

  function wrapCanvas(canvas) {
    const wrapper = document.createElement('div');
    wrapper.className = 'canvas-wrapper';
    const displayW = canvas.dataset.displayWidth || canvas.width;
    wrapper.style.width = displayW + 'px';
    wrapper.appendChild(canvas);
    return wrapper;
  }

  // ── Download ───────────────────────────────────────────────────

  window.downloadPdf = function (name) {
    const s = store[name];
    if (!s) return;
    const b64 = s.anonymizedBase64;
    if (!b64) return;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
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
})();
