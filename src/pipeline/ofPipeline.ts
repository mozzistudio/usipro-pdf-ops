import crypto from 'crypto';
import JSZip from 'jszip';
import { OFData, PartFeedback, PipelineResult } from '../types';
import { CLIENT_CODE, buildDropboxPaths, getExtension, isPdf, isStep } from '../utils/helpers';
import { ofLogger } from '../utils/logger';
import * as dropboxService from '../services/dropbox';
import * as documentGenerator from '../services/documentGenerator';
import * as zipService from '../services/zip';
import * as pdfAnonymizer from '../services/pdfAnonymizer';
import {
  PipelineState,
  PendingSelectionState,
  CandidateDoc,
  PartDocs,
  saveState,
  getState,
  savePendingSelection,
  getPendingSelection,
  deleteState,
} from '../services/sessionStore';
import { selectPlanPdf } from '../services/planSelector';
import {
  WorkSource,
  addWorkFile,
  recordWorkDelivered,
  recordWorkStarted,
} from '../services/worksStore';
import { Attachment, attachPart } from '../services/articleStore';

/** One anonymized plan handed to the operator for validation. */
export interface Phase1Pdf {
  partId: string;
  originalBase64: string;
  anonymizedBase64: string;
  /**
   * Detected cartouche format. Sent to the UI so a retour given on this plan is
   * filed against the family it belongs to rather than against every client.
   */
  format?: string;
  /** Set only when the client left a comment on this part. */
  feedback?: PartFeedback;
}

/** Ce que le référentiel article sait de la pièce, au moment où elle arrive. */
export interface PartAttachment {
  partId: string;
  mode: Attachment['mode'];
  summary: string;
  candidates: Attachment['candidates'];
  history: Attachment['history'];
}

export type Phase1Result =
  | {
      status: 'pending_validation';
      sessionId: string;
      resolvedOF: string;
      pdfs: Phase1Pdf[];
      missingParts: string[];
      /** Vide quand le référentiel est indisponible — jamais une erreur bloquante. */
      attachments: PartAttachment[];
    }
  | {
      status: 'awaiting_selection';
      sessionId: string;
      resolvedOF: string;
      pending: Array<{
        partId: string;
        candidates: Array<{ name: string; pathDisplay: string; thumbnailBase64: string | null }>;
      }>;
    };

/**
 * Phase 1 — Search, (possibly) ask user to pick a plan, copy, anonymize PDFs.
 *
 * If any partId's folder contains multiple PDFs and Claude Vision cannot
 * confidently identify the plan, the pipeline pauses and returns
 * `awaiting_selection` with first-page thumbnails so the frontend can prompt
 * the user. Call `resumePhase1AfterSelection` with the user's picks to finish.
 */
export async function runPipelinePhase1(
  ofData: OFData,
  /** Form submission or mail to chiffrage@ — kept for the index of work. */
  source: WorkSource = 'form',
): Promise<Phase1Result> {
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

  // ─── Step 2: Search Dropbox for technical docs ───────────────
  log.info({ partCount: parts.length }, 'Step 2: Searching Dropbox for technical docs');
  const partIds = parts.map(p => p.id.trim());
  const webhookDocs = await dropboxService.fetchDocsFromDropbox(partIds);
  log.info({ docCount: webhookDocs.length }, 'Dropbox search returned docs');

  // ─── Step 2a: Group PDFs by partId and run AI selection when needed ──
  const pdfsByPart = new Map<string, Array<{ name: string; pathDisplay: string }>>();
  for (const doc of webhookDocs) {
    if (!isPdf(doc.name) || !doc.path_display) continue;
    if (!pdfsByPart.has(doc.partId)) pdfsByPart.set(doc.partId, []);
    pdfsByPart.get(doc.partId)!.push({ name: doc.name, pathDisplay: doc.path_display });
  }

  const partDocs: PartDocs[] = [];
  const ambiguous: Array<{
    partId: string;
    candidates: Array<{ name: string; pathDisplay: string; thumbnailBase64: string | null }>;
  }> = [];

  for (const [partId, list] of pdfsByPart) {
    if (list.length === 1) {
      partDocs.push({
        partId,
        candidates: [{ name: list[0].name, pathDisplay: list[0].pathDisplay, pdfBytes: Buffer.alloc(0) }],
        selectedIndex: 0,
      });
      continue;
    }

    log.info({ partId, count: list.length }, 'Multiple PDFs found for part — running AI selection');
    const candidates: CandidateDoc[] = await Promise.all(
      list.map(async l => ({
        name: l.name,
        pathDisplay: l.pathDisplay,
        pdfBytes: await dropboxService.downloadFile(l.pathDisplay),
      })),
    );

    const selection = await selectPlanPdf(candidates, { partId, ofNumber: resolvedOF });
    log.info(
      { partId, selectedIndex: selection.selectedIndex, confidence: selection.confidence, reason: selection.reason },
      'AI plan selection result',
    );

    if (selection.confidence === 'high') {
      partDocs.push({ partId, candidates, selectedIndex: selection.selectedIndex });
    } else {
      partDocs.push({ partId, candidates, selectedIndex: null });
      ambiguous.push({
        partId,
        candidates: candidates.map((c, i) => ({
          name: c.name,
          pathDisplay: c.pathDisplay,
          thumbnailBase64: selection.thumbnails[i] ? selection.thumbnails[i]!.toString('base64') : null,
        })),
      });
    }
  }

  // ─── Also track STEP/STP docs (not subject to selection) ──────
  const stepDocs = webhookDocs.filter(d => isStep(d.name) && d.path_display);

  // ─── If any partId is ambiguous, pause and ask the user ──────
  if (ambiguous.length > 0) {
    const sessionId = crypto.randomUUID();
    const missingParts = computeMissingParts(partIds, pdfsByPart, stepDocs);
    const pending: PendingSelectionState = {
      kind: 'pending_selection',
      ofNumber,
      resolvedOF,
      parts,
      paths,
      partDocs,
      missingParts,
      source,
      createdAt: Date.now(),
    };
    savePendingSelection(sessionId, pending);
    // Persist STEP docs alongside — store them as synthetic PartDocs with empty buffers
    // Actually we carry them separately via the session state's partDocs invariant:
    // STEP files don't need selection and will be handled at resume time by re-reading
    // the webhookDocs filter. To avoid re-listing Dropbox, stash them on the session:
    (pending as any)._stepDocs = stepDocs;

    log.info({ sessionId, ambiguousCount: ambiguous.length }, 'Phase 1 paused — awaiting user selection');
    return {
      status: 'awaiting_selection',
      sessionId,
      resolvedOF,
      pending: ambiguous,
    };
  }

  // ─── Otherwise, finish Phase 1 now ────────────────────────────
  return finishPhase1(ofData, resolvedOF, paths, partDocs, stepDocs, source);
}

/**
 * Resume Phase 1 after the user picked which PDF to use for each ambiguous part.
 */
export async function resumePhase1AfterSelection(
  sessionId: string,
  selections: Array<{ partId: string; chosenPath: string }>,
): Promise<Phase1Result> {
  const pending = getPendingSelection(sessionId);
  if (!pending) {
    throw new Error(`Session introuvable ou expirée: ${sessionId}`);
  }
  const log = ofLogger(pending.resolvedOF);

  const chosenByPart = new Map(selections.map(s => [s.partId, s.chosenPath]));
  for (const pd of pending.partDocs) {
    if (pd.selectedIndex !== null) continue;
    const chosen = chosenByPart.get(pd.partId);
    if (!chosen) {
      throw new Error(`Sélection manquante pour la pièce ${pd.partId}`);
    }
    const idx = pd.candidates.findIndex(c => c.pathDisplay === chosen);
    if (idx < 0) {
      throw new Error(`Sélection invalide pour la pièce ${pd.partId}: ${chosen}`);
    }
    pd.selectedIndex = idx;
  }

  // Clean up the pending-selection state; finishPhase1 will create a fresh
  // pipeline state with a new sessionId.
  deleteState(sessionId);

  const stepDocs = ((pending as any)._stepDocs as Array<{
    name: string;
    path_display: string;
    partId: string;
  }>) || [];

  log.info({ sessionId }, 'Phase 1 resumed with user selections');
  return finishPhase1(
    { ofNumber: pending.ofNumber, parts: pending.parts },
    pending.resolvedOF,
    pending.paths,
    pending.partDocs,
    stepDocs,
    pending.source ?? 'form',
  );
}

function computeMissingParts(
  partIds: string[],
  pdfsByPart: Map<string, Array<{ name: string; pathDisplay: string }>>,
  stepDocs: Array<{ partId: string }>,
): string[] {
  const covered = new Set<string>();
  for (const id of pdfsByPart.keys()) covered.add(id);
  for (const s of stepDocs) covered.add(s.partId);
  return partIds.filter(id => !covered.has(id));
}

async function finishPhase1(
  ofData: OFData,
  resolvedOF: string,
  paths: ReturnType<typeof buildDropboxPaths>,
  partDocs: PartDocs[],
  stepDocs: Array<{ name: string; path_display: string; partId: string }>,
  source: WorkSource,
): Promise<Phase1Result> {
  const log = ofLogger(resolvedOF);
  const partIds = ofData.parts.map(p => p.id.trim());

  let copiedFiles = 0;
  const pdfs: Phase1Pdf[] = [];

  // ─── Copy chosen PDF per partId ───────────────────────────────
  for (const pd of partDocs) {
    if (pd.selectedIndex === null) continue;
    const chosen = pd.candidates[pd.selectedIndex];
    const destPath = `${paths.nm}/${pd.partId}.pdf`;

    // If we already have the bytes in memory (multi-candidate path), upload
    // them directly; otherwise do a Dropbox-to-Dropbox copy (single candidate
    // path — bytes weren't downloaded).
    if (chosen.pdfBytes && chosen.pdfBytes.length > 0) {
      log.info({ to: destPath, name: chosen.name }, 'Uploading cached PDF to NM');
      await dropboxService.uploadFile(destPath, chosen.pdfBytes);
    } else {
      log.info({ from: chosen.pathDisplay, to: destPath }, 'Copying PDF');
      await dropboxService.copyFile(chosen.pathDisplay, destPath);
    }
    copiedFiles++;
  }

  // ─── Copy STEP files ──────────────────────────────────────────
  for (const doc of stepDocs) {
    const ext = getExtension(doc.name);
    const destPath = `${paths.dp}/${doc.partId}.${ext}`;
    log.info({ from: doc.path_display, to: destPath }, 'Copying STEP');
    await dropboxService.copyFile(doc.path_display, destPath);
    copiedFiles++;
  }

  // ─── Missing parts = those with no PDF and no STEP ───────────
  const coveredPartIds = new Set<string>();
  for (const pd of partDocs) if (pd.selectedIndex !== null) coveredPartIds.add(pd.partId);
  for (const s of stepDocs) coveredPartIds.add(s.partId);
  const missingParts = partIds.filter(id => !coveredPartIds.has(id));

  // ─── Abort if no technical files were found ─────────────────
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

  // ─── Anonymize PDFs in NM folder ─────────────────────────────
  log.info('Anonymizing PDFs in NM folder');

  // Free-text feedback the client typed against each part in the form. It steers
  // the cartouche fields of the anonymized PDF, so it must reach anonymizePdf.
  const commentByPart = new Map(
    ofData.parts.map(p => [p.id.trim(), p.comment?.trim() ?? '']),
  );

  for (const pd of partDocs) {
    if (pd.selectedIndex === null) continue;
    const nmPath = `${paths.nm}/${pd.partId}.pdf`;
    try {
      const pdfBytes = await dropboxService.downloadFile(nmPath);
      const originalBase64 = pdfBytes.toString('base64');

      const comment = commentByPart.get(pd.partId) || undefined;
      const { pdf: anonBytes, format, refinement } = await pdfAnonymizer.anonymizePdf(
        pdfBytes,
        pd.partId,
        resolvedOF,
        comment,
        { partId: pd.partId, ofNumber: resolvedOF },
      );
      const anonymizedBase64 = anonBytes.toString('base64');

      await dropboxService.uploadFile(nmPath, anonBytes);
      if (refinement?.unhandled) {
        log.warn(
          { partId: pd.partId, comment, unhandled: refinement.unhandled },
          'Client feedback could not be applied to the cartouche',
        );
      }
      log.info(
        { partId: pd.partId, feedbackApplied: Object.keys(refinement?.overrides ?? {}) },
        'PDF anonymized in NM folder',
      );

      pdfs.push({
        partId: pd.partId,
        originalBase64,
        anonymizedBase64,
        format,
        ...(comment && {
          feedback: {
            comment,
            applied: Object.keys(refinement?.overrides ?? {}),
            unhandled: refinement?.unhandled ?? null,
          },
        }),
      });
    } catch (err: any) {
      log.warn({ partId: pd.partId, err: err.message }, 'Failed to anonymize PDF — keeping original');
      try {
        const pdfBytes = await dropboxService.downloadFile(nmPath);
        const b64 = pdfBytes.toString('base64');
        // Anonymization failed, so no feedback was applied — say so explicitly
        // rather than leaving the operator to assume the comment was handled.
        const comment = commentByPart.get(pd.partId) || undefined;
        pdfs.push({
          partId: pd.partId,
          originalBase64: b64,
          anonymizedBase64: b64,
          ...(comment && {
            feedback: {
              comment,
              applied: [],
              unhandled: "l'anonymisation a échoué — commentaire non appliqué",
            },
          }),
        });
      } catch {
        // Skip entirely if download also fails
      }
    }
  }

  // ─── Save state & return ─────────────────────────────────────
  const newSessionId = crypto.randomUUID();
  const state: PipelineState = {
    ofNumber: ofData.ofNumber,
    resolvedOF,
    parts: ofData.parts,
    paths,
    pdfs,
    missingParts,
    createdAt: Date.now(),
  };
  saveState(newSessionId, state);

  // ─── Rattachement au référentiel article ─────────────────────
  // Identité avant prix : on dit ce que cette pièce a déjà vécu avant que
  // quiconque parle de chiffrage. Un référentiel injoignable fait perdre le
  // rattachement, jamais les plans déjà anonymisés.
  const stepByPart = new Map(stepDocs.map(d => [d.partId, d.path_display]));
  const attachments: PartAttachment[] = [];

  for (const partId of partIds) {
    try {
      const stepPath = stepByPart.get(partId);
      const stepBytes = stepPath ? await dropboxService.downloadFile(stepPath) : undefined;
      const pdf = pdfs.find(p => p.partId === partId);
      const planSha256 = pdf
        ? crypto.createHash('sha256').update(Buffer.from(pdf.originalBase64, 'base64')).digest('hex')
        : undefined;

      const attachment = await attachPart({
        client: CLIENT_CODE,
        reference: partId,
        sourceOf: resolvedOF,
        stepBytes,
        planSha256,
      });

      attachments.push({
        partId,
        mode: attachment.mode,
        summary: attachment.summary,
        candidates: attachment.candidates,
        history: attachment.history,
      });
    } catch (err: any) {
      log.warn({ partId, err: err.message }, 'Rattachement impossible — la pièce reste sans historique');
    }
  }

  // Indexed now rather than at delivery: a lot abandoned during validation is
  // still work that happened, and the home must show it. A failure here never
  // costs the operator the plans that are already anonymized.
  try {
    await recordWorkStarted({
      tool: 'edition',
      source,
      ref: resolvedOF,
      client: CLIENT_CODE,
      partIds,
      planCount: pdfs.length,
      missingParts,
    });
  } catch (err: any) {
    log.error({ err: err.message }, 'Travail non indexé — la home ne le montrera pas');
  }

  log.info(
    {
      sessionId: newSessionId,
      pdfCount: pdfs.length,
      missingParts,
      attached: attachments.length,
      propositions: attachments.filter(a => a.mode === 'proposition').length,
    },
    'Phase 1 complete — awaiting validation',
  );
  return {
    status: 'pending_validation',
    sessionId: newSessionId,
    resolvedOF,
    pdfs,
    missingParts,
    attachments,
  };
}

/**
 * Phase 2 — Finalize: upload validated PDFs, create ZIP, generate devis, shared link.
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

  deleteState(sessionId);

  const missingParts = state.missingParts;

  // ─── Step 8: Keep our own copy of what was delivered ──────────
  // Dropbox is where the client's files live; this is where OUR trace lives.
  // Archiving is best-effort: an OF that reached Dropbox is delivered whether
  // or not our copy succeeded.
  try {
    for (const { partId, pdfBase64 } of validatedPdfs) {
      await addWorkFile({
        tool: 'edition',
        ref: resolvedOF,
        kind: 'plan_anonymise',
        partId,
        fileName: `${partId}.pdf`,
        bytes: Buffer.from(pdfBase64, 'base64'),
        contentType: 'application/pdf',
      });
    }
    await addWorkFile({
      tool: 'edition',
      ref: resolvedOF,
      kind: 'devis_pdf',
      fileName: `${resolvedOF}.pdf`,
      bytes: pdfBuffer,
      contentType: 'application/pdf',
    });
    await addWorkFile({
      tool: 'edition',
      ref: resolvedOF,
      kind: 'devis_docx',
      fileName: `${resolvedOF}.docx`,
      bytes: docxBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await recordWorkDelivered('edition', resolvedOF, {
      dropboxLink,
      planCount: validatedPdfs.length,
      missingParts,
      client: CLIENT_CODE,
    });
  } catch (err: any) {
    log.error({ err: err.message }, 'Archivage du travail incomplet — les fichiers sont sur Dropbox');
  }

  log.info({ dropboxLink, missingParts }, 'Pipeline completed successfully');
  return { ofNumber: resolvedOF, dropboxLink, missingParts, zipBase64, mainPath: paths.main };
}

/**
 * Legacy: Execute the full OF pipeline (both phases) in one call.
 * Kept for backwards compatibility — only works when no ambiguous selection is needed.
 */
export async function runPipeline(ofData: OFData): Promise<PipelineResult> {
  const phase1 = await runPipelinePhase1(ofData);
  if (phase1.status !== 'pending_validation') {
    throw new Error('runPipeline() non supporté quand une sélection utilisateur est nécessaire');
  }
  const validatedPdfs = phase1.pdfs.map(p => ({
    partId: p.partId,
    pdfBase64: p.anonymizedBase64,
  }));
  return runPipelinePhase2(phase1.sessionId, validatedPdfs);
}
