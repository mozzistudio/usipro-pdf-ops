import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import {
  WorkTool,
  getPricingSettings,
  listClientPricing,
  listMaterialRates,
  listRequestLines,
  listWorkFiles,
  listWorks,
  priceRequest,
  requestLineCounts,
  reviewLine,
  setClientPricing,
  setMaterialRate,
  setPricingSettings,
  setWorkProject,
  setWorkStatus,
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
 * GET  /api/pricing/settings  — paramètres du moteur et tarifs matière
 * POST /api/pricing/settings  — corriger un paramètre du moteur
 * POST /api/pricing/materials — corriger le tarif d'une nuance
 * POST /api/works/:id/price   — (re)chiffrer une demande
 * POST /api/lines/:id/review  — la décision du technicien sur une ligne
 * GET  /api/pricing           — les prix par défaut, par client
 * POST /api/pricing           — poser ou changer le prix par défaut d'un client
 * POST /api/works/:id/status  — l'opérateur clôt une demande, ou la rouvre
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

      const ids = works.map(w => w.id);
      const fileCounts = await workFileCounts(ids);
      const lineCounts = await requestLineCounts(ids);

      res.json({
        status: 'ok',
        count: works.length,
        facets: await workFacets(),
        works: works.map(w => ({
          ...w,
          feedback: counts.get(w.ref) ?? { plus: 0, minus: 0 },
          fileCount: fileCounts[w.id] ?? 0,
          lineCount: lineCounts[w.id] ?? 0,
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

  // ── Moteur de coût ─────────────────────────────────────────────
  // Les valeurs livrées sont des hypothèses. L'atelier les corrige ici, et
  // chaque demande peut être rechiffrée avec les nouvelles.
  router.get('/api/pricing/settings', async (_req: Request, res: Response) => {
    try {
      const [settings, materials] = await Promise.all([getPricingSettings(), listMaterialRates()]);
      res.json({ status: 'ok', settings, materials });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Lecture des paramètres de prix impossible');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  router.post('/api/pricing/settings', async (req: Request, res: Response) => {
    const patch = req.body as Record<string, unknown>;
    const numeric = [
      'hourlyRate', 'setupMinutes', 'minutesPerDm3',
      'removalRatio', 'learningCurve', 'marginPct', 'handlingMinutesPerPart',
    ];

    for (const key of numeric) {
      if (patch[key] === undefined) continue;
      const value = Number(patch[key]);
      if (!Number.isFinite(value) || value < 0) {
        res.status(400).json({ status: 'error', message: `${key} doit être un nombre positif` });
        return;
      }
      patch[key] = value;
    }

    try {
      res.json({ status: 'ok', settings: await setPricingSettings(patch as any) });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Paramètres de prix non enregistrés');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  router.post('/api/pricing/materials', async (req: Request, res: Response) => {
    const { id, pricePerKg, density, label, aliases } = req.body as {
      id?: string; pricePerKg?: number; density?: number; label?: string; aliases?: string[];
    };
    if (!id || !String(id).trim()) {
      res.status(400).json({ status: 'error', message: 'id de nuance requis' });
      return;
    }
    for (const [key, value] of [['pricePerKg', pricePerKg], ['density', density]] as const) {
      if (value === undefined) continue;
      if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
        res.status(400).json({ status: 'error', message: `${key} doit être un nombre positif` });
        return;
      }
    }

    try {
      const materials = await setMaterialRate(String(id).trim(), {
        pricePerKg: pricePerKg === undefined ? undefined : Number(pricePerKg),
        density: density === undefined ? undefined : Number(density),
        label,
        aliases,
      });
      res.json({ status: 'ok', materials });
    } catch (err: any) {
      logger.error({ err: err.message, id }, 'Tarif matière non enregistré');
      res.status(400).json({ status: 'error', message: err.message });
    }
  });

  // La décision du technicien sur une ligne. Quatre issues distinctes, parce
  // qu'un prix imposé, une ligne à recalculer et une ligne sortie du chiffrage
  // ne racontent pas la même chose au reste de la chaîne.
  router.post('/api/lines/:lineId/review', async (req: Request, res: Response) => {
    const { action, price, note } = req.body as {
      action?: string;
      price?: number | null;
      note?: string;
    };
    const actions = ['valider', 'forcer', 'recalculer', 'manuel', 'rejeter'];
    if (!action || !actions.includes(action)) {
      res.status(400).json({ status: 'error', message: `action doit être l'une de: ${actions.join(', ')}` });
      return;
    }

    try {
      const line = await reviewLine(String(req.params.lineId), action as any, {
        price: price === undefined || price === null ? null : Number(price),
        note,
      });
      res.json({ status: 'ok', line });
    } catch (err: any) {
      logger.error({ err: err.message, lineId: req.params.lineId, action }, 'Décision non enregistrée');
      res.status(400).json({ status: 'error', message: err.message });
    }
  });

  router.post('/api/works/:id/price', async (req: Request, res: Response) => {
    try {
      const lines = await priceRequest(String(req.params.id));
      res.json({ status: 'ok', count: lines.length, lines });
    } catch (err: any) {
      logger.error({ err: err.message, id: req.params.id }, 'Chiffrage impossible');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  // ── Prix par défaut, par client ────────────────────────────────
  // Aucun moteur de coût n'existe: ces valeurs sont posées à la main et
  // affichées comme telles. L'API les expose séparément des demandes pour
  // qu'on ne puisse jamais les confondre avec un prix calculé.
  router.get('/api/pricing', async (_req: Request, res: Response) => {
    try {
      res.json({ status: 'ok', pricing: await listClientPricing() });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Lecture des prix clients impossible');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  router.post('/api/pricing', async (req: Request, res: Response) => {
    const { client, defaultUnitPrice, note } = req.body as {
      client?: string;
      defaultUnitPrice?: number | null;
      note?: string;
    };

    if (!client || !String(client).trim()) {
      res.status(400).json({ status: 'error', message: 'client est requis' });
      return;
    }
    const price =
      defaultUnitPrice === null || defaultUnitPrice === undefined ? null : Number(defaultUnitPrice);
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      res.status(400).json({ status: 'error', message: 'defaultUnitPrice doit être un nombre positif ou null' });
      return;
    }

    try {
      const pricing = await setClientPricing(String(client).trim(), price, note);
      res.json({ status: 'ok', pricing });
    } catch (err: any) {
      logger.error({ err: err.message, client }, 'Prix client non enregistré');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  router.post('/api/works/:id/status', async (req: Request, res: Response) => {
    const { status } = req.body as { status?: string };
    if (status !== 'a_valider' && status !== 'livre') {
      res.status(400).json({ status: 'error', message: "status doit être 'a_valider' ou 'livre'" });
      return;
    }

    try {
      const updated = await setWorkStatus(String(req.params.id), status);
      if (!updated) {
        res.status(404).json({ status: 'error', message: 'Travail introuvable' });
        return;
      }
      res.json({ status: 'ok', work: updated });
    } catch (err: any) {
      logger.error({ err: err.message, id: req.params.id }, 'Statut non enregistré');
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
