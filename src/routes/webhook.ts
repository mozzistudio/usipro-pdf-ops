import { Router, Request, Response } from 'express';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { FormPayload, FinalizeRequest, AddUsIproTableRequest } from '../types';
import { parseFormPayload } from '../utils/helpers';
import { logger } from '../utils/logger';
import { runPipelinePhase1, runPipelinePhase2 } from '../pipeline/ofPipeline';
import * as dropboxService from '../services/dropbox';
import * as pdfEditor from '../services/pdfEditor';
import * as pdfAnonymizer from '../services/pdfAnonymizer';

export const apiRouter = Router();

/**
 * POST /api/anonymize-zone
 *
 * Applies white rectangle masks over the given zones on a PDF.
 * Body: { pdfBase64: string, zones: Zone[] }
 * Response: { pdfBase64: string }
 */
apiRouter.post('/api/anonymize-zone', async (req: Request, res: Response) => {
  const { pdfBase64, zones } = req.body as { pdfBase64: string; zones: pdfEditor.Zone[] };

  if (!pdfBase64 || !Array.isArray(zones) || zones.length === 0) {
    res.status(400).json({ error: 'pdfBase64 et zones sont requis' });
    return;
  }

  try {
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    const modified = await pdfEditor.applyWhiteZones(pdfBytes, zones);
    res.json({ pdfBase64: modified.toString('base64') });
  } catch (err: any) {
    logger.error({ err: err.message }, 'anonymize-zone failed');
    res.status(500).json({ error: 'Échec du traitement PDF' });
  }
});

/**
 * POST /api/anonymize-pdf
 *
 * Auto-detects the client format and applies the appropriate
 * cartouche mask + USI-PRO footer to all pages of the PDF.
 * Body: { pdfBase64: string, planId: string, lotId: string }
 * Response: { pdfBase64: string }
 */
apiRouter.post('/api/anonymize-pdf', async (req: Request, res: Response) => {
  const { pdfBase64, planId, lotId, refinementPrompt } = req.body as {
    pdfBase64: string;
    planId: string;
    lotId: string;
    refinementPrompt?: string;
  };

  if (!pdfBase64 || !planId || !lotId) {
    res.status(400).json({ error: 'pdfBase64, planId et lotId sont requis' });
    return;
  }

  try {
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    const { pdf, format } = await pdfAnonymizer.anonymizePdf(pdfBytes, planId, lotId, refinementPrompt);
    res.json({ pdfBase64: pdf.toString('base64'), format });
  } catch (err: any) {
    logger.error({ err: err.message }, 'anonymize-pdf failed');
    res.status(500).json({ error: 'Échec anonymisation PDF' });
  }
});

/**
 * POST /api/add-usipro-table
 *
 * Adds a USI-PRO table to the original PDF at the specified zone.
 * Whites out the zone first, then draws the branded table.
 */
apiRouter.post('/api/add-usipro-table', async (req: Request, res: Response) => {
  const { pdfBase64, planId, lotId, zone, cartoucheData } = req.body as AddUsIproTableRequest;

  if (!pdfBase64 || !planId || !lotId || !zone) {
    res.status(400).json({ error: 'pdfBase64, planId, lotId et zone sont requis' });
    return;
  }

  try {
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    const doc = await PDFDocument.load(pdfBytes);
    const fonts = {
      reg: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };

    // Embed logo
    let logoImg = null;
    try {
      const logoBuf = pdfAnonymizer.getLogoPng();
      if (logoBuf) logoImg = await doc.embedPng(logoBuf);
    } catch {
      // Continue without logo
    }

    const page = doc.getPage(zone.page);
    if (!page) {
      res.status(400).json({ error: `Page ${zone.page} introuvable` });
      return;
    }

    const data = cartoucheData || {
      designation: '—',
      material: '—',
      applicableStd: '—',
      finish: '—',
    };

    await pdfAnonymizer.drawUsIproTable(page, zone, planId, lotId, data, logoImg, fonts);

    const result = Buffer.from(await doc.save());
    res.json({ pdfBase64: result.toString('base64') });
  } catch (err: any) {
    logger.error({ err: err.message }, 'add-usipro-table failed');
    res.status(500).json({ error: 'Échec ajout table USI-PRO' });
  }
});

/**
 * GET /api/debug/list-plans/:id
 *
 * Lists the contents of /Analyses/RIJ/Plans/:id on Dropbox.
 * Useful for debugging missing files.
 */
apiRouter.get('/api/debug/list-plans/:id', async (req: Request, res: Response) => {
  const partId = req.params.id.trim();
  const folderPath = `/Analyses/RIJ/Plans/${partId}`;

  logger.info({ partId, folderPath }, 'Debug: listing plans folder');

  try {
    const entries = await dropboxService.listFolderEntries(folderPath);
    res.json({
      status: 'ok',
      folder: folderPath,
      count: entries.length,
      entries: entries.map((e) => ({
        type: e.tag,
        name: e.name,
        path: e.pathDisplay,
      })),
    });
  } catch (err: any) {
    const summary = err?.error?.error_summary || err.message;
    const notFound = summary.includes('path/not_found');
    res.status(notFound ? 404 : 500).json({
      status: 'error',
      folder: folderPath,
      message: notFound ? `Dossier introuvable: ${folderPath}` : summary,
    });
  }
});

/**
 * POST /api/submit
 *
 * Phase 1: Receives form submissions, runs search + anonymization,
 * returns PDFs for user validation.
 */
apiRouter.post('/api/submit', async (req: Request, res: Response) => {
  const payload = req.body as FormPayload;

  let ofData;
  try {
    ofData = parseFormPayload(payload);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Invalid form submission');
    res.status(400).json({ status: 'error', message: err.message });
    return;
  }

  logger.info(
    { of: ofData.ofNumber, partCount: ofData.parts.length },
    'Form submitted — running pipeline phase 1',
  );

  try {
    const result = await runPipelinePhase1(ofData);

    res.status(200).json({
      status: 'pending_validation',
      sessionId: result.sessionId,
      of: result.resolvedOF,
      pdfs: result.pdfs,
      missingParts: result.missingParts,
    });
  } catch (err: any) {
    const detail = err?.error?.error_summary || err?.error || err.message;
    logger.error(
      { of: ofData.ofNumber, err: err.message, detail, status: err?.status, stack: err.stack },
      'Pipeline phase 1 failed',
    );
    res.status(500).json({
      status: 'error',
      message: `Le traitement de l'OF ${ofData.ofNumber} a échoué: ${detail}`,
    });
  }
});

/**
 * POST /api/finalize
 *
 * Phase 2: Receives validated PDFs, creates ZIP, generates devis,
 * uploads to Dropbox, returns final result.
 */
apiRouter.post('/api/finalize', async (req: Request, res: Response) => {
  const { sessionId, validatedPdfs } = req.body as FinalizeRequest;

  if (!sessionId || !Array.isArray(validatedPdfs) || validatedPdfs.length === 0) {
    res.status(400).json({ status: 'error', message: 'sessionId et validatedPdfs sont requis' });
    return;
  }

  logger.info(
    { sessionId, pdfCount: validatedPdfs.length },
    'Finalize request — running pipeline phase 2',
  );

  try {
    const result = await runPipelinePhase2(sessionId, validatedPdfs);

    res.status(200).json({
      status: 'success',
      of: result.ofNumber,
      dropboxLink: result.dropboxLink,
      missingParts: result.missingParts,
      zipBase64: result.zipBase64,
      mainPath: result.mainPath,
    });
  } catch (err: any) {
    const detail = err?.error?.error_summary || err?.error || err.message;
    logger.error(
      { sessionId, err: err.message, detail, stack: err.stack },
      'Pipeline phase 2 failed',
    );
    res.status(500).json({
      status: 'error',
      message: `La finalisation a échoué: ${detail}`,
    });
  }
});
