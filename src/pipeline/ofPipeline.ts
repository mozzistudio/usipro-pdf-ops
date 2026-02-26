import crypto from 'crypto';
import JSZip from 'jszip';
import { OFData, PipelineResult } from '../types';
import { buildDropboxPaths, getExtension, isPdf, isStep } from '../utils/helpers';
import { ofLogger } from '../utils/logger';
import * as dropboxService from '../services/dropbox';
import * as documentGenerator from '../services/documentGenerator';
import * as zipService from '../services/zip';
import * as pdfAnonymizer from '../services/pdfAnonymizer';
import { PipelineState, saveState, getState, deleteState } from '../services/sessionStore';

/**
 * Phase 1 — Search, copy, anonymize PDFs. Returns data for frontend validation.
 *
 * Steps:
 *  1. Resolve OF number (append suffix if folder exists)
 *  2. Create Dropbox folder structure (OF, NM, DP)
 *  3. Search & copy technical files (PDF → NM, STEP → DP)
 *  4. Anonymize PDFs automatically
 *  5. Download originals + anonymized versions
 *  6. Save state in memory, return PDFs for validation
 */
export async function runPipelinePhase1(ofData: OFData): Promise<{
  sessionId: string;
  resolvedOF: string;
  pdfs: Array<{ partId: string; originalBase64: string; anonymizedBase64: string }>;
  missingParts: string[];
}> {
  const { ofNumber, parts } = ofData;
  const log = ofLogger(ofNumber);

  // ─── Resolve OF number: append A/B/C suffix if folder exists ──
  let resolvedOF = ofNumber;
  const SUFFIXES = ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  for (const suffix of SUFFIXES) {
    const candidate = `${ofNumber}${suffix}`;
    const exists = await dropboxService.folderExists(buildDropboxPaths(candidate).main);
    if (!exists) {
      resolvedOF = candidate;
      break;
    }
  }
  if (resolvedOF !== ofNumber) {
    log.info({ original: ofNumber, resolved: resolvedOF }, 'OF folder already exists — using suffixed name');
  }

  const paths = buildDropboxPaths(resolvedOF);

  // ─── Step 1: Create Dropbox folder structure ──────────────────
  log.info('Step 1: Creating Dropbox folder structure');
  await dropboxService.createFolder(paths.main);
  await dropboxService.createFolder(paths.nm);
  await dropboxService.createFolder(paths.dp);
  log.info({ paths }, 'Folder structure created');

  // ─── Step 2: Search Dropbox directly for technical docs ──────
  log.info({ partCount: parts.length }, 'Step 2: Searching Dropbox for technical docs');
  const partIds = parts.map(p => p.id.trim());
  const webhookDocs = await dropboxService.fetchDocsFromDropbox(partIds);
  log.info({ docCount: webhookDocs.length }, 'Dropbox search returned docs');

  const missingParts: string[] = [];
  let copiedFiles = 0;

  for (const doc of webhookDocs) {
    const sourcePath = doc.path_display;
    const fileName = doc.name;

    if (!sourcePath) {
      log.warn({ doc }, 'Doc entry has no path — skipping');
      continue;
    }

    if (isPdf(fileName)) {
      const destPath = `${paths.nm}/${doc.partId}.pdf`;
      log.info({ from: sourcePath, to: destPath }, 'Copying PDF');
      await dropboxService.copyFile(sourcePath, destPath);
      copiedFiles++;
    } else if (isStep(fileName)) {
      const ext = getExtension(fileName);
      const destPath = `${paths.dp}/${doc.partId}.${ext}`;
      log.info({ from: sourcePath, to: destPath }, 'Copying STEP');
      await dropboxService.copyFile(sourcePath, destPath);
      copiedFiles++;
    }
  }

  // Track parts that had no matching docs
  const foundPartIds = new Set(webhookDocs.map(d => d.partId));
  for (const id of partIds) {
    if (!foundPartIds.has(id)) {
      missingParts.push(id);
    }
  }

  // ─── Abort if no technical files were found ─────────────────────
  if (copiedFiles === 0) {
    log.warn({ missingParts }, 'No technical files found in Dropbox — aborting pipeline');
    await Promise.all([
      dropboxService.deletePath(paths.nm).catch(() => {}),
      dropboxService.deletePath(paths.dp).catch(() => {}),
      dropboxService.deletePath(paths.main).catch(() => {}),
    ]);
    throw new Error(
      `Aucun fichier technique (PDF/STEP) trouvé dans Dropbox pour les pièces: ${partIds.join(', ')}`,
    );
  }

  // ─── Step 2.5: Anonymize PDFs in NM folder ───────────────────
  log.info('Step 2.5: Anonymizing PDFs in NM folder');
  const pdfDocs = webhookDocs.filter(d => isPdf(d.name));
  const pdfs: Array<{ partId: string; originalBase64: string; anonymizedBase64: string }> = [];

  for (const doc of pdfDocs) {
    const nmPath = `${paths.nm}/${doc.partId}.pdf`;
    try {
      const pdfBytes = await dropboxService.downloadFile(nmPath);
      const originalBase64 = pdfBytes.toString('base64');

      const { pdf: anonBytes } = await pdfAnonymizer.anonymizePdf(pdfBytes, doc.partId, resolvedOF);
      const anonymizedBase64 = anonBytes.toString('base64');

      // Upload anonymized version to NM folder
      await dropboxService.uploadFile(nmPath, anonBytes);
      log.info({ partId: doc.partId }, 'PDF anonymized in NM folder');

      pdfs.push({ partId: doc.partId, originalBase64, anonymizedBase64 });
    } catch (err: any) {
      log.warn({ partId: doc.partId, err: err.message }, 'Failed to anonymize PDF — keeping original');
      // Still include original so user can manually add table
      try {
        const pdfBytes = await dropboxService.downloadFile(nmPath);
        const b64 = pdfBytes.toString('base64');
        pdfs.push({ partId: doc.partId, originalBase64: b64, anonymizedBase64: b64 });
      } catch {
        // Skip entirely if download also fails
      }
    }
  }

  // ─── Save state & return ──────────────────────────────────────
  const sessionId = crypto.randomUUID();
  const state: PipelineState = {
    ofNumber,
    resolvedOF,
    parts,
    paths,
    pdfs,
    missingParts,
    createdAt: Date.now(),
  };
  saveState(sessionId, state);

  log.info({ sessionId, pdfCount: pdfs.length, missingParts }, 'Phase 1 complete — awaiting validation');
  return { sessionId, resolvedOF, pdfs, missingParts };
}

/**
 * Phase 2 — Finalize: upload validated PDFs, create ZIP, generate devis, shared link.
 *
 * Steps:
 *  1. Upload each validated PDF to NM folder on Dropbox
 *  2. Create NM ZIP from validated PDFs
 *  3. Generate PDF + DOCX devis
 *  4. Upload ZIP + devis to Dropbox
 *  5. Build full ZIP (NM.zip + DP contents)
 *  6. Delete temp NM folder
 *  7. Create shared link
 */
export async function runPipelinePhase2(
  sessionId: string,
  validatedPdfs: Array<{ partId: string; pdfBase64: string }>,
): Promise<PipelineResult> {
  const state = getState(sessionId);
  if (!state) {
    throw new Error(`Session introuvable ou expirée: ${sessionId}`);
  }

  const { resolvedOF, parts, paths } = state;
  const log = ofLogger(resolvedOF);

  log.info({ sessionId, validatedCount: validatedPdfs.length }, 'Phase 2: Finalizing');

  // ─── Step 1: Upload validated PDFs to NM folder + build NM ZIP ──
  log.info('Step 1: Uploading validated PDFs and creating NM ZIP');
  const nmZip = new JSZip();

  for (const { partId, pdfBase64 } of validatedPdfs) {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const nmPath = `${paths.nm}/${partId}.pdf`;
    await dropboxService.uploadFile(nmPath, pdfBuffer);
    nmZip.file(`${partId}.pdf`, pdfBuffer);
    log.info({ partId }, 'Validated PDF uploaded to NM');
  }

  const nmZipBuffer = await nmZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  // ─── Step 2: Upload NM ZIP ────────────────────────────────────
  log.info('Step 2: Uploading NM ZIP');
  await dropboxService.uploadFile(`${paths.main}/NM${resolvedOF}.zip`, nmZipBuffer);

  // ─── Step 3: Generate PDF + DOCX locally ──────────────────────
  log.info('Step 3: Generating PDF and DOCX');
  const [pdfBuffer, docxBuffer] = await Promise.all([
    documentGenerator.generatePdf(resolvedOF, parts),
    documentGenerator.generateDocx(resolvedOF, parts),
  ]);

  // ─── Step 4: Upload devis to Dropbox ──────────────────────────
  log.info('Step 4: Uploading devis to Dropbox');
  await Promise.all([
    dropboxService.uploadFile(`${paths.dp}/${resolvedOF}.pdf`, pdfBuffer),
    dropboxService.uploadFile(`${paths.dp}/${resolvedOF}.docx`, docxBuffer),
  ]);

  // ─── Step 5: Build full ZIP ───────────────────────────────────
  log.info('Step 5: Building full ZIP');
  const fullZip = new JSZip();
  fullZip.file(`NM${resolvedOF}.zip`, nmZipBuffer);
  fullZip.file(`DP${resolvedOF}/${resolvedOF}.pdf`, pdfBuffer);
  fullZip.file(`DP${resolvedOF}/${resolvedOF}.docx`, docxBuffer);

  // Include STEP files from DP folder
  const dpFiles = await dropboxService.listFiles(paths.dp);
  for (const f of dpFiles) {
    if (isStep(f.name)) {
      const content = await dropboxService.downloadFile(f.pathDisplay);
      fullZip.file(`DP${resolvedOF}/${f.name}`, content);
    }
  }

  const fullZipBuffer = await fullZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const zipBase64 = fullZipBuffer.toString('base64');
  log.info({ zipSizeBytes: fullZipBuffer.length }, 'Full ZIP built');

  // ─── Step 6: Delete temporary NM folder ───────────────────────
  log.info('Step 6: Deleting temporary NM folder');
  await dropboxService.deletePath(paths.nm);

  // ─── Step 7: Create shared link ───────────────────────────────
  log.info('Step 7: Creating shared link for OF folder');
  const dropboxLink = await dropboxService.createSharedLink(paths.main);

  // ─── Cleanup session state ────────────────────────────────────
  deleteState(sessionId);

  const missingParts = state.missingParts;
  log.info({ dropboxLink, missingParts }, 'Pipeline completed successfully');
  return { ofNumber: resolvedOF, dropboxLink, missingParts, zipBase64, mainPath: paths.main };
}

/**
 * Legacy: Execute the full OF pipeline (both phases) in one call.
 * Kept for backwards compatibility.
 */
export async function runPipeline(ofData: OFData): Promise<PipelineResult> {
  const phase1 = await runPipelinePhase1(ofData);
  const validatedPdfs = phase1.pdfs.map(p => ({
    partId: p.partId,
    pdfBase64: p.anonymizedBase64,
  }));
  return runPipelinePhase2(phase1.sessionId, validatedPdfs);
}
