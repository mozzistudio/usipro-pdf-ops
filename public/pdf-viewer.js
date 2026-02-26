/**
 * PDF Viewer — validation workflow
 *
 * Per-PDF flow (one at a time):
 *  1. Extract PDFs from the NM ZIP inside the full ZIP
 *  2. Call /api/anonymize-pdf for each PDF → render side-by-side (original | anonymized)
 *  3. User can "Valider" (accept) or type a prompt and click "Affiner" (refine)
 *     "Affiner" re-calls /api/anonymize-pdf with refinementPrompt → re-renders
 *  4. Validated → auto-advance to next PDF (counter: N / total)
 *  5. Once all PDFs are validated, window.onAllPdfsValidated() is called
 *     which calls /api/finalize-pdfs to upload the anonymized NM ZIP to Dropbox
 */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // { filename: { originalBase64, anonymizedBase64, validated, ofNum } }
  const store = {};
  let _totalCount = 0;
  let _currentIndex = 0;
  let _names = [];

  // ── Public API ──────────────────────────────────────────────────
  window.showPdfViewer = async function (zipBase64, ofNum) {
    const section = document.getElementById('pdfSection');
    const container = document.getElementById('pdfCardsContainer');

    section.style.display = 'block';
    container.innerHTML =
      '<div class="pdf-loading"><span class="spinner-small"></span>Chargement des plans…</div>';
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });

    let pdfs;
    try {
      pdfs = await extractPdfs(zipBase64, ofNum);
    } catch (err) {
      container.innerHTML =
        '<div class="pdf-loading" style="color:var(--error)">Erreur lors de l\'extraction des plans.</div>';
      console.error('[pdf-viewer] extract error:', err);
      return;
    }

    const names = Object.keys(pdfs).sort();
    _names = names;
    _currentIndex = 0;
    container.innerHTML = '';
    _totalCount = names.length;

    if (names.length === 0) {
      container.innerHTML = '<div class="pdf-loading">Aucun plan PDF disponible.</div>';
      updateCounter();
      return;
    }

    // Build cards + track originals — show only the first card
    names.forEach((name, i) => {
      store[name] = { originalBase64: pdfs[name], anonymizedBase64: null, validated: false, ofNum };
      const card = buildCard(name);
      card.style.display = i === 0 ? 'block' : 'none';
      container.appendChild(card);
    });

    updateCounter();

    // Anonymize + render in parallel (each card updates independently when ready)
    await Promise.all(names.map((name) => anonymizeAndRender(name, pdfs[name], ofNum)));
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

  // ── ZIP extraction ──────────────────────────────────────────────
  async function extractPdfs(zipBase64, ofNum) {
    const bytes = Uint8Array.from(atob(zipBase64), (c) => c.charCodeAt(0));
    const fullZip = await JSZip.loadAsync(bytes);

    const nmFile = fullZip.file('NM' + ofNum + '.zip');
    if (!nmFile) return {};

    const nmZip = await JSZip.loadAsync(await nmFile.async('arraybuffer'));
    const pdfs = {};
    const tasks = [];

    nmZip.forEach((path, file) => {
      if (!file.dir && path.toLowerCase().endsWith('.pdf')) {
        const name = path.split('/').pop() || path;
        tasks.push(file.async('base64').then((b) => (pdfs[name] = b)));
      }
    });

    await Promise.all(tasks);
    return pdfs;
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
        <button class="btn-dl-modified" onclick="downloadPdf('${name}')">↓ Télécharger</button>
      </div>
      <div class="pdf-pages-list" id="pglist-${fid}">
        <div class="pdf-loading"><span class="spinner-small"></span>Anonymisation…</div>
      </div>
      <div class="pdf-validation-bar" id="vbar-${fid}" style="display:none">
        <button class="btn-validate" onclick="validatePdf('${name}')">✓ Valider</button>
        <div class="affiner-group">
          <input class="affiner-input" id="affinerInput-${fid}"
                 placeholder="Ex: DESIGNATION = SUPPORT OPTIQUE, MATERIAL = Inox 316L"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();affinerPdf('${name}')}" />
          <button class="btn-affiner" onclick="affinerPdf('${name}')">↺ Affiner</button>
        </div>
      </div>
    `;
    return card;
  }

  // ── Anonymize + render ──────────────────────────────────────────
  async function anonymizeAndRender(name, originalBase64, ofNum, refinementPrompt) {
    const fid = fkey(name);
    const planId = name.replace(/\.pdf$/i, '');

    try {
      const body = { pdfBase64: originalBase64, planId, lotId: ofNum };
      if (refinementPrompt) body.refinementPrompt = refinementPrompt;

      const resp = await fetch('/api/anonymize-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const { pdfBase64, format } = await resp.json();

      store[name].anonymizedBase64 = pdfBase64;

      const infoEl = document.getElementById('info-' + fid);
      if (infoEl && format) infoEl.dataset.format = format;

      await renderSideBySide(name, originalBase64, pdfBase64, format);

      // Show validation bar
      const vbar = document.getElementById('vbar-' + fid);
      if (vbar) vbar.style.display = 'flex';

    } catch (err) {
      const pgList = document.getElementById('pglist-' + fid);
      if (pgList)
        pgList.innerHTML =
          '<div class="pdf-loading" style="color:var(--error)">Erreur anonymisation — ' +
          err.message + '</div>';
      console.error('[pdf-viewer] error for', name, err);
    }
  }

  // ── Validate a PDF → advance to next ───────────────────────────
  window.validatePdf = function (name) {
    if (!store[name]) return;
    store[name].validated = true;

    const fid = fkey(name);
    const card = document.getElementById('card-' + fid);
    if (card) card.classList.add('pdf-card-validated');
    const badge = document.getElementById('badge-' + fid);
    if (badge) { badge.textContent = '✓ Validé'; badge.className = 'pdf-validation-badge validated'; }
    const vbar = document.getElementById('vbar-' + fid);
    if (vbar) vbar.innerHTML = '<span class="validated-label">✓ PDF validé</span>';

    // Advance to next card
    if (_currentIndex < _totalCount - 1) {
      _currentIndex++;
      showCurrentCard();
    } else {
      updateCounter();
    }

    checkAllValidated();
  };

  // ── Affiner a PDF ───────────────────────────────────────────────
  window.affinerPdf = async function (name) {
    if (!store[name]) return;
    const fid = fkey(name);
    const input = document.getElementById('affinerInput-' + fid);
    const prompt = input ? input.value.trim() : '';

    // Show loading only on the anonymized columns — keep originals visible
    const pgList = document.getElementById('pglist-' + fid);
    if (pgList) {
      pgList.querySelectorAll('.pdf-comparison-col').forEach((col) => {
        if (col.querySelector('.comparison-label.anonymized')) {
          col.innerHTML =
            '<div class="comparison-label anonymized">Anonymisé</div>' +
            '<div class="pdf-loading anon-loading"><span class="spinner-small"></span>Affinage…</div>';
        }
      });
    }
    const vbar = document.getElementById('vbar-' + fid);
    if (vbar) vbar.style.display = 'none';

    await anonymizeAndRender(name, store[name].originalBase64, store[name].ofNum, prompt || undefined);
  };

  // ── Check if all PDFs are validated → trigger finalization ─────
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
  async function renderSideBySide(name, originalBase64, anonymizedBase64, format) {
    const fid = fkey(name);
    const pgList = document.getElementById('pglist-' + fid);
    const infoEl = document.getElementById('info-' + fid);
    if (!pgList) return;

    const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

    const [origDoc, anonDoc] = await Promise.all([
      pdfjsLib.getDocument({ data: toBytes(originalBase64) }).promise,
      pdfjsLib.getDocument({ data: toBytes(anonymizedBase64) }).promise,
    ]);

    if (infoEl) {
      const pages = anonDoc.numPages + ' page' + (anonDoc.numPages > 1 ? 's' : '');
      infoEl.textContent = format ? `${pages} · ${format}` : pages;
    }

    pgList.innerHTML = '';

    const numPages = Math.max(origDoc.numPages, anonDoc.numPages);
    // Width per column: half of pgList minus padding & gap
    const colW = Math.max((pgList.clientWidth - 60) / 2, 240);

    for (let pn = 1; pn <= numPages; pn++) {
      const entry = document.createElement('div');
      entry.className = 'pdf-page-entry';

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
        col.appendChild(wrapCanvas(await renderPage(origDoc, pn, colW)));
        comparison.appendChild(col);
      }

      if (pn <= anonDoc.numPages) {
        const col = document.createElement('div');
        col.className = 'pdf-comparison-col';
        const lbl = document.createElement('div');
        lbl.className = 'comparison-label anonymized';
        lbl.textContent = 'Anonymisé';
        col.appendChild(lbl);
        col.appendChild(wrapCanvas(await renderPage(anonDoc, pn, colW)));
        comparison.appendChild(col);
      }

      entry.appendChild(comparison);
      pgList.appendChild(entry);
    }
  }

  async function renderPage(pdfDoc, pn, availW) {
    const page = await pdfDoc.getPage(pn);
    const naturalVP = page.getViewport({ scale: 1 });
    const scale = Math.min(availW / naturalVP.width, 2.0);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
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
    if (!s || !s.anonymizedBase64) return;
    const bytes = Uint8Array.from(atob(s.anonymizedBase64), (c) => c.charCodeAt(0));
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

  function fkey(name) {
    return 'pv_' + name.replace(/[^a-zA-Z0-9]/g, '_');
  }
})();
