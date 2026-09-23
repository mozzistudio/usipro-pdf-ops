import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import {
  FEEDBACK_OPERATIONS,
  FeedbackOperation,
  FeedbackScope,
  FeedbackVerdict,
  countActiveForScope,
  listFeedback,
  recordFeedback,
  revokeFeedback,
} from '../services/feedbackStore';

/** Reads a scope out of a request body or query string, ignoring junk. */
function readScope(raw: any): FeedbackScope {
  const src = raw && typeof raw === 'object' ? raw : {};
  const scope: FeedbackScope = {};
  for (const key of ['format', 'client', 'ofNumber', 'partId'] as (keyof FeedbackScope)[]) {
    const value = src[key];
    if (typeof value === 'string' && value.trim()) scope[key] = value.trim();
  }
  return scope;
}

/**
 * Registers the operator feedback endpoints.
 *
 * POST /api/feedback            — record a retour on an operation that just ran
 * GET  /api/feedback            — list retours (filterable), newest first
 * POST /api/feedback/:id/revoke — stop a consigne from steering future runs
 */
export function registerFeedbackEndpoints(router: Router): void {
  router.post('/api/feedback', async (req: Request, res: Response) => {
    const { operation, verdict, comment, scope } = req.body as {
      operation?: string;
      verdict?: string;
      comment?: string;
      scope?: unknown;
    };

    if (!FEEDBACK_OPERATIONS.includes(operation as FeedbackOperation)) {
      res.status(400).json({
        status: 'error',
        message: `operation doit être l'une de: ${FEEDBACK_OPERATIONS.join(', ')}`,
      });
      return;
    }

    if (verdict !== 'ok' && verdict !== 'ko') {
      res.status(400).json({ status: 'error', message: "verdict doit être 'ok' ou 'ko'" });
      return;
    }

    if (comment != null && typeof comment !== 'string') {
      res.status(400).json({ status: 'error', message: 'comment doit être du texte' });
      return;
    }

    // A thumbs-down with nothing written teaches nothing and would silently
    // become a consigne nobody can read. Ask for the reason instead.
    if (verdict === 'ko' && !String(comment ?? '').trim()) {
      res.status(400).json({
        status: 'error',
        message: 'Dis en une phrase ce qui ne va pas — sans texte, rien ne peut être corrigé la prochaine fois',
      });
      return;
    }

    const parsedScope = readScope(scope);

    try {
      const rec = await recordFeedback({
        operation: operation as FeedbackOperation,
        verdict: verdict as FeedbackVerdict,
        comment,
        scope: parsedScope,
      });

      res.status(201).json({
        status: 'ok',
        id: rec.id,
        // Consignes that will steer the next run of this operation in this scope.
        activeForScope: await countActiveForScope(rec.operation, parsedScope),
      });
    } catch (err: any) {
      // Saying "pris en compte" on a retour that was not stored would be a lie
      // the operator only discovers when the same mistake comes back.
      logger.error({ err: err.message }, 'Feedback non enregistré');
      res.status(503).json({ status: 'error', message: `Retour non enregistré: ${err.message}` });
    }
  });

  router.get('/api/feedback', async (req: Request, res: Response) => {
    const operation = String(req.query.operation || '');
    const status = String(req.query.status || '');

    if (operation && !FEEDBACK_OPERATIONS.includes(operation as FeedbackOperation)) {
      res.status(400).json({ status: 'error', message: 'operation inconnue' });
      return;
    }
    if (status && status !== 'active' && status !== 'revoked') {
      res.status(400).json({ status: 'error', message: "status doit être 'active' ou 'revoked'" });
      return;
    }

    try {
      const feedbacks = await listFeedback({
        operation: (operation || undefined) as FeedbackOperation | undefined,
        status: (status || undefined) as 'active' | 'revoked' | undefined,
        scope: readScope(req.query),
      });
      res.json({ status: 'ok', count: feedbacks.length, feedbacks });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Lecture des retours impossible');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  router.post('/api/feedback/:id/revoke', async (req: Request, res: Response) => {
    const id = String(req.params.id || '');

    try {
      const revoked = await revokeFeedback(id);
      if (!revoked) {
        res.status(404).json({ status: 'error', message: 'Consigne introuvable ou déjà révoquée' });
        return;
      }
      logger.info({ id }, 'Consigne révoquée depuis l’interface');
      res.json({ status: 'ok', id, feedback: revoked });
    } catch (err: any) {
      logger.error({ err: err.message, id }, 'Révocation impossible');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });
}
