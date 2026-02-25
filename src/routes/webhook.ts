import { Router, Request, Response } from 'express';
import { FormPayload } from '../types';
import { parseFormPayload } from '../utils/helpers';
import { logger } from '../utils/logger';
import { runPipeline } from '../pipeline/ofPipeline';
import * as dropboxService from '../services/dropbox';

export const apiRouter = Router();

/**
 * GET /api/debug/dropbox-info
 *
 * Returns Dropbox account info including namespace details.
 * Useful for diagnosing path resolution issues on team/business accounts.
 */
apiRouter.get('/api/debug/dropbox-info', async (_req: Request, res: Response) => {
  logger.info('Debug: fetching Dropbox account info');
  try {
    const info = await dropboxService.getAccountInfo();
    res.json({ status: 'ok', ...info });
  } catch (err: any) {
    logger.error({ err: err.message, status: err?.status }, 'Debug: failed to get Dropbox info');
    res.status(500).json({
      status: 'error',
      message: err?.error?.error_summary || err.message,
    });
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
    const notFound = typeof summary === 'string' && summary.includes('path/not_found');
    logger.error(
      { partId, folderPath, errStatus: err?.status, errSummary: err?.error?.error_summary, errMessage: err.message },
      'Debug: list-plans failed',
    );
    res.status(notFound ? 404 : 500).json({
      status: 'error',
      folder: folderPath,
      message: notFound ? `Dossier introuvable: ${folderPath}` : summary,
      details: { status: err?.status, errorSummary: err?.error?.error_summary },
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
