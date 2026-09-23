import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import {
  WorkTool,
  listRequestLines,
  listWorkFiles,
  listWorks,
  setWorkProject,
  workFacets,
  workFileCounts,
} from '../services/worksStore';
import { listFeedback } from '../services/feedbackStore';

const TOOLS: WorkTool[] = ['edition', 'chiffrage'];

/**
 * Registers the index of work done — what the home page reads.
 *
 * GET  /api/works             — the jobs, newest activity first, with their tags
 * GET  /api/works/:id/files   — the deliverables of one job, as signed URLs
 * GET  /api/works/:id/lines   — les lignes d'une demande de chiffrage
 * POST /api/works/:id/project — set the project tag (the one no pipeline knows)
 */
export function registerWorksEndpoints(router: Router): void {
  router.get('/api/works', async (req: Request, res: Response) => {
    const tool = String(req.query.tool || '');
    if (tool && !TOOLS.includes(tool as WorkTool)) {
      res.status(400).json({ status: 'error', message: 'tool inconnu' });
      return;
    }

    try {
      const works = await listWorks({
        tool: (tool || undefined) as WorkTool | undefined,
        client: String(req.query.client || '') || undefined,
        project: String(req.query.project || '') || undefined,
        limit: Math.min(Number(req.query.limit) || 60, 200),
      });

      // Retours are counted per OF in one pass rather than one query per job.
      const feedbacks = await listFeedback({ status: 'active', limit: 500 });
      const counts = new Map<string, { plus: number; minus: number }>();
      for (const f of feedbacks) {
        const ref = f.scope.ofNumber;
        if (!ref) continue;
        const entry = counts.get(ref) ?? { plus: 0, minus: 0 };
        if (f.verdict === 'ok') entry.plus++;
        else entry.minus++;
        counts.set(ref, entry);
      }

      const fileCounts = await workFileCounts(works.map(w => w.id));

      res.json({
        status: 'ok',
        count: works.length,
        facets: await workFacets(),
        works: works.map(w => ({
          ...w,
          feedback: counts.get(w.ref) ?? { plus: 0, minus: 0 },
          fileCount: fileCounts[w.id] ?? 0,
        })),
      });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Lecture des travaux impossible');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  router.get('/api/works/:id/files', async (req: Request, res: Response) => {
    try {
      const files = await listWorkFiles(String(req.params.id));
      res.json({ status: 'ok', count: files.length, files });
    } catch (err: any) {
      logger.error({ err: err.message, id: req.params.id }, 'Lecture des livrables impossible');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  router.get('/api/works/:id/lines', async (req: Request, res: Response) => {
    try {
      const lines = await listRequestLines(String(req.params.id));
      res.json({ status: 'ok', count: lines.length, lines });
    } catch (err: any) {
      logger.error({ err: err.message, id: req.params.id }, 'Lecture des lignes impossible');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  router.post('/api/works/:id/project', async (req: Request, res: Response) => {
    const { project } = req.body as { project?: string | null };
    if (project != null && typeof project !== 'string') {
      res.status(400).json({ status: 'error', message: 'project doit être du texte ou null' });
      return;
    }

    try {
      const updated = await setWorkProject(String(req.params.id), project ?? null);
      if (!updated) {
        res.status(404).json({ status: 'error', message: 'Travail introuvable' });
        return;
      }
      res.json({ status: 'ok', work: updated });
    } catch (err: any) {
      logger.error({ err: err.message, id: req.params.id }, 'Tag projet non enregistré');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });
}
