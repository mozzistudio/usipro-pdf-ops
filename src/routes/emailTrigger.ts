import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { parseChiffrageEmail, InboundEmail } from '../services/emailParser';
import { expandArchive, readAttachment } from '../services/attachments';
import {
  addWorkFile,
  clearInbox,
  createInboxUpload,
  priceRequest,
  readInboxObject,
  recordChiffrageRequest,
} from '../services/worksStore';
import { attachPart } from '../services/articleStore';
import { AnalysisNotebook } from '../services/analysisJournal';
import { CLAUDE_MODEL } from '../services/claudeModel';
import type { ReadAttachment } from '../services/attachments';

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
  /**
   * Les URL de dépôt des pièces jointes d'un message.
   *
   * La plateforme refuse tout corps de requête au-delà de 4,5 Mo — un package
   * de plans les dépasse sans effort, et le pont se voyait répondre 413 puis
   * abandonnait le mail au bout de cinq essais. Il dépose donc désormais les
   * fichiers directement dans le seau et ne nous envoie que leurs noms.
   */
  router.post('/api/email-trigger/uploads', async (req: Request, res: Response) => {
    const expected = config.emailTrigger.secret;
    if (!expected) {
      res.status(503).json({ status: 'error', message: 'Trigger email non configuré' });
      return;
    }
    if (!secretMatches(String(req.get('x-trigger-secret') || ''), expected)) {
      logger.warn({ ip: req.ip }, 'Dépôt de pièces jointes: secret invalide');
      res.status(401).json({ status: 'error', message: 'Non autorisé' });
      return;
    }

    const messageId = String(req.body?.messageId || '');
    const names: string[] = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!messageId || names.length === 0) {
      res.status(400).json({ status: 'error', message: 'messageId et files requis' });
      return;
    }

    try {
      const uploads = [];
      for (const [index, name] of names.slice(0, 60).entries()) {
        const slot = await createInboxUpload(messageId, String(name), index);
        if (!slot) {
          res.status(503).json({ status: 'error', message: 'Stockage non configuré' });
          return;
        }
        uploads.push({ name: String(name), path: slot.path, url: slot.url });
      }
      res.json({ status: 'ok', uploads });
    } catch (err: any) {
      logger.error({ err: err.message, messageId }, 'URL de dépôt impossible');
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

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
/**
 * Ce que la lecture d'une pièce jointe a donné, en une phrase.
 *
 * Écrite depuis le résultat de `readAttachment`, donc depuis ce qui est
 * réellement parti au modèle — pas depuis ce qu'on espérait en tirer. Un plan
 * scanné dit qu'il n'a pas de couche texte ; une image trop lourde dit qu'elle
 * n'a pas été transmise. C'est cette phrase-là qui explique un prix faux.
 */
function describeRead(file: ReadAttachment): { message: string; level: 'info' | 'warn' } {
  const origin = file.fromArchive ? `extrait de ${file.fromArchive} · ` : '';
  const weight = file.size ? `${Math.max(1, Math.round(file.size / 1024))} Ko · ` : '';

  if (file.note) return { message: `${origin}${weight}${file.note}`, level: 'warn' };
  if (file.image) {
    return { message: `${origin}${weight}image transmise au modèle (${file.image.mediaType})`, level: 'info' };
  }
  if (file.stepBytes) {
    return { message: `${origin}${weight}STEP reçu — géométrie conservée pour l'empreinte`, level: 'info' };
  }
  if (file.text.trim()) {
    return {
      message: `${origin}${weight}${file.kind} lu — ${file.text.length} caractères de texte transmis au modèle`,
      level: 'info',
    };
  }
  return { message: `${origin}${weight}${file.kind} sans contenu exploitable`, level: 'warn' };
}

async function handleEmail(inbound: InboundEmail): Promise<{ status: number; body: unknown }> {
  // Le carnet suit toute l'analyse ; il n'est versé au journal qu'une fois la
  // demande identifiée, puisque son identifiant n'existe pas avant.
  const notebook = new AnalysisNotebook();
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
  // quantités et les matières dans deux demandes sur trois. Celles que le pont
  // a déposées dans le seau sont relues ici; les petites arrivent encore en
  // ligne, pour qu'un pont non mis à jour continue de fonctionner.
  const staged: string[] = [];
  const incoming = await Promise.all(
    (inbound.attachments ?? []).map(async (att: any) => {
      if (att?.contentBase64 || !att?.storagePath) return att;
      try {
        const bytes = await readInboxObject(String(att.storagePath));
        if (!bytes) {
          notebook.note('lecture', 'fichier annoncé par le pont mais absent du dépôt', { file: String(att.name), level: 'error' });
          return { ...att, skipped: 'fichier absent du dépôt' };
        }
        staged.push(String(att.storagePath));
        return { ...att, size: bytes.length, contentBase64: bytes.toString('base64') };
      } catch (err: any) {
        logger.warn({ file: att.name, err: err.message }, 'Pièce jointe déposée illisible');
        return { ...att, skipped: `dépôt illisible: ${err.message}` };
      }
    }),
  );

  const direct = await Promise.all(incoming.map(readAttachment));

  // Une archive n'apprend rien; son contenu, si. Les membres rejoignent la
  // liste et suivent exactement le chemin d'une pièce jointe ordinaire.
  const files = [...direct];
  const extracted: Array<{ name: string; bytes: Buffer }> = [];

  for (const [index, file] of direct.entries()) {
    if (file.kind !== 'archive') continue;
    const bytes = incoming[index]?.contentBase64
      ? Buffer.from(incoming[index].contentBase64, 'base64')
      : null;
    if (!bytes) continue;

    const { members, note } = await expandArchive(file.name, bytes);
    for (const member of members) {
      files.push(member.read);
      extracted.push({ name: member.read.name, bytes: member.bytes });
    }
    if (note) file.note = `${file.note ?? 'archive'} — ${note}`;
    notebook.note('lecture',
      `archive ouverte — ${members.length} fichier${members.length > 1 ? 's' : ''} en sont sortis` +
      (note ? ` · ${note}` : ''),
      { file: file.name });
    logger.info({ archive: file.name, membres: members.length }, 'Archive ouverte');
  }

  // Une ligne par pièce jointe, avant l'extraction : ce sont ces fichiers-là,
  // et eux seuls, que le modèle va voir.
  for (const file of files) {
    if (file.kind === 'archive') continue;   // son ouverture est déjà notée
    const { message, level } = describeRead(file);
    notebook.note('lecture', message, { file: file.name, level });
  }
  if (files.length === 0) {
    notebook.note('lecture', 'aucune pièce jointe — le chiffrage s\'appuie sur le seul texte du mail', { level: 'warn' });
  }

  let request;
  try {
    request = await parseChiffrageEmail(inbound, files);
  } catch (err: any) {
    // Une newsletter ou une alerte de sécurité n'est pas une panne: 422 pour
    // que le pont l'étiquette et cesse de la rejouer.
    logger.warn({ subject: inbound.subject, err: err.message }, 'Mail non exploitable');
    return { status: 422, body: { status: 'rejected', message: err.message } };
  }

  const images = files.filter(f => f.image).length;
  const texts = files.filter(f => f.text.trim()).length;
  notebook.note('extraction',
    `modèle ${CLAUDE_MODEL} — ${request.lines.length} article${request.lines.length > 1 ? 's' : ''} extrait${request.lines.length > 1 ? 's' : ''} ` +
    `de ${texts} document${texts > 1 ? 's' : ''} en texte et ${images} image${images > 1 ? 's' : ''}`);
  if (request.summary) notebook.note('extraction', request.summary);
  if (request.detailsInAttachments) {
    notebook.note('extraction',
      'le fond de la demande est dans les pièces jointes ou derrière un lien — la liste extraite peut être incomplète',
      { level: 'warn' });
  }
  for (const link of request.links) {
    notebook.note('extraction', `lien de partage à ouvrir à la main : ${link}`, { level: 'warn' });
  }

  try {
    const work = await recordChiffrageRequest(request, 'email');

    // Chiffrage immédiat: l'opérateur ouvre la demande avec un prix déjà posé,
    // ses hypothèses affichées, et corrige plutôt que de partir de rien. Un
    // moteur en panne ne doit pas faire perdre la demande.
    let pricedLines = 0;
    try {
      const priced = await priceRequest(work.id);
      pricedLines = priced.length;
      const withPrice = priced.filter(l => l.unitPrice != null).length;
      notebook.note('chiffrage',
        `${withPrice} ligne${withPrice > 1 ? 's' : ''} chiffrée${withPrice > 1 ? 's' : ''} sur ${priced.length}` +
        (withPrice < priced.length ? ' — les autres manquent de matière ou d\'encombrement' : ''),
        { level: withPrice < priced.length ? 'warn' : 'info' });
      // Les hypothèses du moteur restent au bordereau de chaque ligne ; le
      // journal ne garde que celles qui ont pesé, pour ne pas les répéter
      // soixante fois sur un devis à soixante articles.
      const assumed = new Set<string>();
      for (const line of priced) for (const alert of line.alerts ?? []) assumed.add(alert);
      for (const assumption of assumed) {
        notebook.note('chiffrage', `hypothèse du calcul : ${assumption}`, { level: 'warn' });
      }
    } catch (err: any) {
      notebook.note('chiffrage', `moteur de coût indisponible : ${err.message}`, { level: 'error' });
      logger.warn({ reference: request.reference, err: err.message }, 'Chiffrage impossible — demande enregistrée sans prix');
    }

    // Les pièces jointes sont archivées chez nous, telles que le client les a
    // envoyées. Elles ne servent pas qu'à extraire des quantités: ce sont les
    // reçus du prix. Si un devis est contesté six mois plus tard, il faut
    // pouvoir rouvrir exactement le tableur sur lequel il a été calculé — et
    // ne pas dépendre pour ça d'une boîte mail que personne ne garantit.
    for (const att of incoming) {
      if (!att.contentBase64) continue; // non transmis: rien à archiver
      try {
        await addWorkFile({
          tool: 'chiffrage',
          ref: work.ref,
          kind: 'piece_jointe',
          fileName: att.name,
          bytes: Buffer.from(att.contentBase64, 'base64'),
          contentType: att.contentType,
        });
      } catch (err: any) {
        // addWorkFile avale déjà ses propres pannes; ce filet ne couvre que le
        // décodage base64 d'une pièce jointe malformée.
        logger.warn(
          { reference: request.reference, file: att.name, err: err.message },
          'Pièce jointe non archivée — la demande reste enregistrée',
        );
      }
    }

    // Un plan tiré d'un zip doit être visible à l'écran comme un plan joint:
    // l'emballage ne change rien à ce que l'opérateur a besoin de regarder.
    for (const member of extracted) {
      try {
        await addWorkFile({
          tool: 'chiffrage',
          ref: work.ref,
          kind: 'piece_jointe',
          fileName: member.name,
          bytes: member.bytes,
        });
      } catch (err: any) {
        logger.warn(
          { reference: request.reference, file: member.name, err: err.message },
          "Fichier d'archive non archivé — la demande reste enregistrée",
        );
      }
    }

    // Le sas n'a plus de raison d'être une fois les fichiers rangés.
    await clearInbox(staged).catch(err =>
      logger.warn({ err: err.message }, "Sas d'entrée non vidé"),
    );

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
        // « Cette pièce est déjà passée » est le fait le plus utile du lot :
        // il dit qu'un prix existe déjà pour la même géométrie.
        notebook.note('extraction', `référentiel — ${result.summary}`, { file: file.name });
        logger.info(
          { reference: request.reference, file: file.name, mode: result.mode, summary: result.summary },
          'STEP rattaché au référentiel',
        );
      } catch (err: any) {
        notebook.note('extraction', `rattachement au référentiel impossible : ${err.message}`, { file: file.name, level: 'warn' });
        logger.warn(
          { reference: request.reference, file: file.name, err: err.message },
          'Rattachement du STEP impossible — la demande reste enregistrée',
        );
      }
    }

    // Le journal est versé en dernier : il raconte l'analyse entière, et une
    // demande enregistrée sans lui reste une demande utilisable.
    await notebook.commit(work.id).catch((err: any) =>
      logger.warn({ reference: work.ref, err: err.message }, 'Journal d’analyse non versé'),
    );

    logger.info(
      {
        reference: work.ref,
        client: work.client,
        lineCount: request.lines.length,
        detailsInAttachments: request.detailsInAttachments,
        fileCount: files.length,
        stepCount: files.filter(f => f.stepBytes).length,
        pricedLines,
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
