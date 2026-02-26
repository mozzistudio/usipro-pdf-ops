import { Router, Request, Response } from 'express';
import { FormPayload } from '../types';
import { parseFormPayload } from '../utils/helpers';
import { logger } from '../utils/logger';
import { runPipeline } from '../pipeline/ofPipeline';
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
 * Receives form submissions directly from the frontend.
 * Runs the pipeline and returns the Dropbox link as output.
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
    'Form submitted — running pipeline',
  );

  try {
    const result = await runPipeline(ofData);

    res.status(200).json({
      status: 'success',
      of: result.ofNumber,
      dropboxLink: result.dropboxLink,
      missingParts: result.missingParts,
      zipBase64: result.zipBase64,
      mainPath: result.mainPath,
    });
  } catch (err: any) {
    // Extract detailed error info (Dropbox SDK embeds it in err.error)
    const detail = err?.error?.error_summary || err?.error || err.message;
    logger.error(
      { of: ofData.ofNumber, err: err.message, detail, status: err?.status, stack: err.stack },
      'Pipeline failed',
    );
    res.status(500).json({
      status: 'error',
      message: `Le traitement de l'OF ${ofData.ofNumber} a échoué: ${detail}`,
    });
  }
});
