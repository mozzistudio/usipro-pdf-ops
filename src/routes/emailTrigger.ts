import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { parseEmailToPayload, InboundEmail } from '../services/emailParser';
import { parseFormPayload } from '../utils/helpers';
import { runPipelinePhase1 } from '../pipeline/ofPipeline';

/**
 * Constant-time comparison so a wrong secret leaks nothing through timing.
 * Lengths are compared first because timingSafeEqual throws on a mismatch.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Outcome of a Gmail message already seen by this endpoint.
 *
 * The bridge waits on the HTTP response, but UrlFetchApp gives up after about
 * a minute while a Phase 1 on a real OF (Dropbox scan, Claude plan selection,
 * anonymization) can run longer. Without this, the bridge reads its own
 * timeout as a server fault, replays the mail, and the pipeline runs twice on
 * the same OF — duplicating Dropbox reads and Claude calls.
 *
 * Keyed by Gmail message id, which is stable across replays.
 */
interface TriggerRun {
  startedAt: number;
  promise: Promise<{ status: number; body: unknown }>;
}

const runs = new Map<string, TriggerRun>();

/** Forget runs older than an hour so the map doesn't grow without bound. */
function pruneRuns(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, run] of runs) {
    if (run.startedAt < cutoff) runs.delete(id);
  }
}

/**
 * Registers the email trigger endpoint.
 *
 * POST /api/email-trigger
 *
 * Called by the Apps Script bridge watching chiffrage@usi-pro.com.
 * Runs Phase 1 only: the OF is searched, plans are anonymized and a session
 * is opened — an operator still validates on the web UI before anything is
 * written back. An email can therefore never finalize an OF on its own.
 *
 * The sender address is NOT trusted for authorization: anyone can forge a
 * From header. The shared secret in x-trigger-secret is what gates the call.
 */
export function registerEmailTriggerEndpoint(router: Router): void {
  router.post('/api/email-trigger', async (req: Request, res: Response) => {
    const expected = config.emailTrigger.secret;
    if (!expected) {
      logger.error('EMAIL_TRIGGER_SECRET non configuré — endpoint désactivé');
      res.status(503).json({ status: 'error', message: 'Trigger email non configuré' });
      return;
    }

    const provided = String(req.get('x-trigger-secret') || '');
    if (!secretMatches(provided, expected)) {
      logger.warn({ ip: req.ip }, 'Email trigger: secret invalide');
      res.status(401).json({ status: 'error', message: 'Non autorisé' });
      return;
    }

    const email = req.body as InboundEmail;
    if (!email || typeof email.body !== 'string') {
      res.status(400).json({ status: 'error', message: 'Corps de mail manquant' });
      return;
    }

    const inbound: InboundEmail = {
      from: String(email.from || ''),
      subject: String(email.subject || ''),
      body: email.body,
    };

    const messageId = String(email.messageId || '');

    logger.info(
      { from: inbound.from, subject: inbound.subject, messageId },
      'Email trigger reçu',
    );

    // A replay of a message already handled — or still running — must not start
    // a second pipeline. Awaiting the original promise means a bridge retry
    // gets the real outcome instead of a duplicate run.
    if (messageId) {
      pruneRuns();
      const existing = runs.get(messageId);
      if (existing) {
        logger.info({ messageId }, 'Email trigger: rejeu ignoré, exécution déjà connue');
        const outcome = await existing.promise;
        res.status(outcome.status).json(outcome.body);
        return;
      }
    }

    const work = handleEmail(inbound);
    if (messageId) {
      runs.set(messageId, { startedAt: Date.now(), promise: work });
    }

    const outcome = await work;
    res.status(outcome.status).json(outcome.body);
  });
}

/**
 * Parses the mail and runs Phase 1, returning the HTTP outcome rather than
 * writing it, so a replayed message can be served the original result.
 */
async function handleEmail(inbound: InboundEmail): Promise<{ status: number; body: unknown }> {
  // Checked before parsing so a missing key can't be mistaken for an
  // unreadable mail: the 422 below tells the bridge to file the thread and
  // never replay it, which would silently drop real requests over a config
  // problem. 503 keeps the mail pending until the key is set.
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.error('ANTHROPIC_API_KEY absente — extraction email impossible');
    return {
      status: 503,
      body: { status: 'error', message: 'Extraction indisponible: ANTHROPIC_API_KEY absente' },
    };
  }

  let payload;
  try {
    payload = parseFormPayload(await parseEmailToPayload(inbound));
  } catch (err: any) {
    // A mail that isn't a chiffrage request is expected traffic, not a server
    // fault — 422 so the bridge can label it and stop retrying.
    logger.warn({ subject: inbound.subject, err: err.message }, 'Email non exploitable');
    return { status: 422, body: { status: 'rejected', message: err.message } };
  }

  try {
    const result = await runPipelinePhase1(payload);

    logger.info(
      { of: result.resolvedOF, sessionId: result.sessionId, status: result.status },
      'Email trigger: phase 1 terminée',
    );

    return {
      status: 200,
      body: {
        status: result.status === 'awaiting_selection' ? 'awaiting_selection' : 'pending_validation',
        sessionId: result.sessionId,
        of: result.resolvedOF,
      },
    };
  } catch (err: any) {
    const detail = err?.error?.error_summary || err?.error || err.message;
    logger.error(
      { of: payload.ofNumber, err: err.message, detail, stack: err.stack },
      'Email trigger: phase 1 échouée',
    );
    return {
      status: 500,
      body: {
        status: 'error',
        message: `Le traitement de l'OF ${payload.ofNumber} a échoué: ${detail}`,
      },
    };
  }
}
