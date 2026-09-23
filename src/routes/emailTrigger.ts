import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { parseChiffrageEmail, InboundEmail } from '../services/emailParser';
import { readAttachment } from '../services/attachments';
import { recordChiffrageRequest } from '../services/worksStore';
import { attachPart } from '../services/articleStore';

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
 * Appelé par le pont Apps Script qui surveille chiffrage@usi-pro.com.
 * Le mail devient une demande de chiffrage enregistrée, rien de plus: aucun
 * prix n'est calculé et rien n'est écrit chez le client. Un opérateur reprend
 * la main depuis l'application.
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
      attachments: Array.isArray(email.attachments) ? email.attachments : [],
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
 * Lit le mail et enregistre la demande de chiffrage, en renvoyant l'issue HTTP
 * plutôt que de l'écrire, pour qu'un message rejoué reçoive le résultat
 * d'origine.
 *
 * Cette adresse est l'entrée du chiffrage, pas de l'édition de plans : aucune
 * recherche Dropbox, aucune anonymisation, et surtout **aucun numéro d'OF
 * attendu**. Un OF est une notion de fabrication, attribuée bien après le
 * chiffrage ; l'exiger ici revenait à rejeter toutes les vraies demandes.
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

  // Les pièces jointes sont lues avant l'extraction: c'est là que sont les
  // quantités et les matières dans deux demandes sur trois.
  const files = await Promise.all((inbound.attachments ?? []).map(readAttachment));

  let request;
  try {
    request = await parseChiffrageEmail(inbound, files);
  } catch (err: any) {
    // Une newsletter ou une alerte de sécurité n'est pas une panne: 422 pour
    // que le pont l'étiquette et cesse de la rejouer.
    logger.warn({ subject: inbound.subject, err: err.message }, 'Mail non exploitable');
    return { status: 422, body: { status: 'rejected', message: err.message } };
  }

  try {
    const work = await recordChiffrageRequest(request, 'email');

    // Chaque STEP reçu entre au référentiel: c'est ce qui permettra de dire,
    // la prochaine fois, « cette pièce est déjà passée ». Un référentiel
    // injoignable ne doit pas faire perdre la demande elle-même.
    const attachments = [] as Array<{ file: string; mode: string; summary: string }>;
    for (const file of files) {
      if (!file.stepBytes) continue;
      try {
        const result = await attachPart({
          client: work.client,
          reference: file.name.replace(/\.(stp|step)$/i, ''),
          sourceOf: request.reference,
          stepBytes: file.stepBytes,
          designation: file.name,
        });
        attachments.push({ file: file.name, mode: result.mode, summary: result.summary });
        logger.info(
          { reference: request.reference, file: file.name, mode: result.mode, summary: result.summary },
          'STEP rattaché au référentiel',
        );
      } catch (err: any) {
        logger.warn(
          { reference: request.reference, file: file.name, err: err.message },
          'Rattachement du STEP impossible — la demande reste enregistrée',
        );
      }
    }

    logger.info(
      {
        reference: work.ref,
        client: work.client,
        lineCount: request.lines.length,
        detailsInAttachments: request.detailsInAttachments,
        fileCount: files.length,
        stepCount: files.filter(f => f.stepBytes).length,
      },
      'Email trigger: demande de chiffrage enregistrée',
    );

    return {
      status: 200,
      body: {
        status: 'enregistre',
        reference: work.ref,
        client: work.client,
        lines: request.lines.length,
        detailsInAttachments: request.detailsInAttachments,
        summary: request.summary,
      },
    };
  } catch (err: any) {
    // Le mail a été lu mais rien n'a été gardé: 500, pour que le pont réessaie
    // plutôt que de classer une demande qui n'existe nulle part.
    logger.error(
      { reference: request.reference, err: err.message, stack: err.stack },
      'Email trigger: demande non enregistrée',
    );
    return {
      status: 500,
      body: { status: 'error', message: `Demande ${request.reference} non enregistrée: ${err.message}` },
    };
  }
}
