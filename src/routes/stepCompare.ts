/**
 * Endpoints behind /step-compare.html — the before/after review page for
 * STEP anonymization. Read-only: nothing here writes to Dropbox.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { isStep } from '../utils/helpers';
import { compareStep } from '../services/stepCompare';
import * as dropboxService from '../services/dropbox';

const PLANS_BASE = '/Analyses/RIJ/Plans';

export function registerStepCompareEndpoints(router: Router): void {
  /**
   * POST /api/step/compare
   * Body: { fileName: string, fileBase64: string }
   * Runs the anonymizer on an uploaded file and returns the full comparison.
   */
  router.post('/api/step/compare', (req: Request, res: Response) => {
    const { fileName, fileBase64 } = req.body as { fileName?: string; fileBase64?: string };

    if (!fileBase64) {
      res.status(400).json({ error: 'fileBase64 est requis' });
      return;
    }

    try {
      const buffer = Buffer.from(fileBase64, 'base64');
      if (buffer.length === 0) {
        res.status(400).json({ error: 'Fichier vide' });
        return;
      }
      const result = compareStep(fileName || 'fichier.step', buffer);
      logger.info(
        { fileName, size: buffer.length, residuals: result.residualsAfter.length },
        'STEP comparison (upload)',
      );
      res.json(result);
    } catch (err: any) {
      logger.error({ fileName, err: err.message }, 'step/compare failed');
      res.status(500).json({ error: `Échec de l'analyse: ${err.message}` });
    }
  });

  /**
   * GET /api/step/search?partId=13315
   * Lists the STEP files sitting in that part's Plans folder.
   */
  router.get('/api/step/search', async (req: Request, res: Response) => {
    const partId = String(req.query.partId || '').trim();
    if (!partId) {
      res.status(400).json({ error: 'partId est requis' });
      return;
    }

    const folderPath = `${PLANS_BASE}/${partId}`;
    try {
      const files = await dropboxService.listFiles(folderPath);
      const steps = files
        .filter((f) => isStep(f.name))
        .map((f) => ({ name: f.name, path: f.pathDisplay }));
      logger.info({ partId, folderPath, count: steps.length }, 'STEP search on Dropbox');
      res.json({ partId, folder: folderPath, files: steps });
    } catch (err: any) {
      const summary = err?.error?.error_summary || err.message;
      const notFound = String(summary).includes('path/not_found');
      res.status(notFound ? 404 : 500).json({
        error: notFound ? `Dossier introuvable: ${folderPath}` : summary,
      });
    }
  });

  /**
   * POST /api/step/compare-dropbox
   * Body: { path: string }
   * Downloads a STEP file from Dropbox and returns the same comparison.
   */
  router.post('/api/step/compare-dropbox', async (req: Request, res: Response) => {
    const { path } = req.body as { path?: string };
    if (!path) {
      res.status(400).json({ error: 'path est requis' });
      return;
    }
    if (!isStep(path)) {
      res.status(400).json({ error: 'Le chemin ne pointe pas vers un fichier STEP' });
      return;
    }

    try {
      const buffer = await dropboxService.downloadFile(path);
      const fileName = path.split('/').pop() || 'fichier.step';
      const result = compareStep(fileName, buffer);
      logger.info(
        { path, size: buffer.length, residuals: result.residualsAfter.length },
        'STEP comparison (Dropbox)',
      );
      res.json(result);
    } catch (err: any) {
      const summary = err?.error?.error_summary || err.message;
      logger.error({ path, err: summary }, 'step/compare-dropbox failed');
      res.status(500).json({ error: `Échec du téléchargement ou de l'analyse: ${summary}` });
    }
  });
}
