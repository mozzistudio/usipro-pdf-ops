import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL, THINKING, parseJsonResponse } from './claudeModel';
import { ChiffrageLine, ChiffrageRequest, FormPayload, Part } from '../types';
import {
  InboundAttachment,
  ReadAttachment,
  attachmentsToPrompt,
  findSharingLinks,
} from './attachments';
import { logger } from '../utils/logger';

/** An inbound email as forwarded by the Apps Script bridge. */
export interface InboundEmail {
  from: string;
  subject: string;
  body: string;
  /** Gmail message id — used to recognize a replayed message, not for parsing. */
  messageId?: string;
  /** Pièces jointes transmises par le pont, contenu compris quand il tient. */
  attachments?: InboundAttachment[];
}

interface ExtractionResult {
  of: string | null;
  parts: Array<Partial<Part>>;
  reason: string;
}

const SYSTEM_PROMPT = `Tu lis un email adressé à un atelier d'usinage et tu en extrais une demande de chiffrage.

Retourne STRICTEMENT un JSON de la forme:
{"of": "<numéro OF sans le préfixe OF, ou null>", "parts": [{"id": "...", "material": "...", "quantity": "...", "processing": "...", "comment": "..."}], "reason": "..."}

Règles:
- "of" est le numéro d'ordre de fabrication. Il apparaît souvent sous la forme OF364575J, "OF 364575", "ordre 364575J". Retourne-le SANS le préfixe "OF" (donc "364575J").
- Chaque pièce a un identifiant/référence ("id"). C'est le seul champ réellement obligatoire.
- "material", "quantity", "processing", "comment" sont facultatifs: chaîne vide si l'email ne les donne pas.
- "comment" reçoit toute consigne libre du client sur la pièce (tolérances, finition, urgence...).
- N'INVENTE RIEN. Un champ absent reste une chaîne vide. Si aucun numéro OF n'est identifiable, "of" vaut null.
- Ignore les signatures, les citations de fils précédents (lignes commençant par ">"), les mentions légales.
- "reason" explique en une phrase ce que tu as trouvé, ou pourquoi l'extraction a échoué.

Pas de markdown, pas d'explication hors JSON.`;

/** Normalize a field Claude may have omitted or returned as null. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Extract an OF number and its parts from a free-text email using Claude.
 *
 * The email is written by a human, so the shape varies wildly — a table, a
 * bullet list, or a sentence. Rather than maintain regexes per client, the
 * extraction is delegated to the model, and the result is validated here
 * before it reaches the pipeline.
 *
 * Throws when the email cannot be turned into a usable payload; the caller is
 * expected to surface that rather than run the pipeline on a guess.
 */
export async function parseEmailToPayload(email: InboundEmail): Promise<FormPayload> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY absent — extraction email impossible');
  }

  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    thinking: THINKING,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `De: ${email.from}\nObjet: ${email.subject}\n\n${email.body}`,
      },
    ],
  } as any);

  const extracted = parseJsonResponse<ExtractionResult>(msg);

  const ofNumber = str(extracted.of).replace(/^OF\s*/i, '');
  if (!ofNumber) {
    throw new Error(`Aucun numéro OF identifiable dans l'email — ${extracted.reason}`);
  }

  const parts: Part[] = (extracted.parts || [])
    .filter(p => str(p.id))
    .map(p => ({
      id: str(p.id),
      material: str(p.material),
      quantity: str(p.quantity),
      processing: str(p.processing),
      comment: str(p.comment),
    }));

  if (parts.length === 0) {
    throw new Error(`Aucune pièce identifiable dans l'email — ${extracted.reason}`);
  }

  logger.info(
    { of: ofNumber, partCount: parts.length, reason: extracted.reason },
    'Email parsed into OF payload',
  );

  return { of: ofNumber, parts };
}


// ── Demande de chiffrage ─────────────────────────────────────────

interface ChiffrageExtraction {
  reference: string | null;
  client: string | null;
  lines: Array<Partial<ChiffrageLine>>;
  summary: string;
  details_in_attachments: boolean;
  is_chiffrage_request: boolean;
}

const CHIFFRAGE_PROMPT = `Tu lis un email reçu par un atelier d'usinage sur son adresse de chiffrage, et tu en extrais une demande de prix.

Retourne STRICTEMENT un JSON:
{"is_chiffrage_request": true|false, "reference": "<réf de la demande ou null>", "client": "<donneur d'ordres ou null>", "lines": [{"reference": "...", "designation": "...", "material": "...", "quantity": "...", "comment": "..."}], "details_in_attachments": true|false, "summary": "..."}

Règles:
- N'ATTENDS AUCUN NUMÉRO D'OF. Un OF est une notion de fabrication interne, créée après le chiffrage. Son absence est normale et ne doit jamais faire échouer l'extraction.
- "reference" est la référence de la demande telle qu'elle apparaît: DE5421, CC5296, "notre consultation 1180", un numéro d'affaire. Si l'objet du mail en porte une, prends-la. Sinon null.
- "client" est le DONNEUR D'ORDRES, c'est-à-dire celui qui demande le prix — pas l'atelier, pas la personne qui transfère le mail en interne. Ces mails sont souvent des transferts: la vraie demande est dans le message réexpédié, en dessous.
- "lines": une entrée par pièce demandée. Tous les champs sont facultatifs et valent "" s'ils ne sont pas donnés. Une ligne sans quantité est une information, pas un vide à combler.
- "details_in_attachments" vaut true quand la demande renvoie à un contenu que tu n'as PAS sous les yeux: pièce jointe non transmise, plans annoncés mais absents, lien de partage à ouvrir. Si le contenu d'une pièce jointe t'est donné plus bas, lis-le et remplis les lignes: il n'est alors plus "en pièce jointe", il est devant toi.
- Le contenu des pièces jointes, quand il est fourni, arrive après le corps sous "CONTENU DES PIÈCES JOINTES". Un tableur y est aplati ligne à ligne, séparateurs " | ". Les en-têtes, totaux et lignes vides sont à ignorer; ne retiens que les lignes qui décrivent une pièce à chiffrer.
- "is_chiffrage_request" vaut false pour tout ce qui n'est pas une demande de prix: newsletter, alerte de sécurité, facture, relance administrative.
- N'INVENTE RIEN. Aucune matière, aucune quantité, aucune référence qui ne soit écrite noir sur blanc.
- "summary" décrit la demande en une phrase, en français, pour un opérateur qui n'a pas ouvert le mail.

Pas de markdown, pas d'explication hors JSON.`;

/**
 * Lit un mail de demande de chiffrage.
 *
 * Contrairement au chemin OF, rien ici n'est obligatoire sauf le fait que ce
 * soit bien une demande de prix : une demande dont tout le contenu est en
 * pièce jointe est enregistrée quand même, avec ce qu'on sait. La refuser
 * reviendrait à perdre une consultation parce qu'elle a été écrite en deux
 * lignes et un fichier Excel.
 */
export async function parseChiffrageEmail(
  email: InboundEmail,
  /** Pièces jointes déjà lues — leur texte entre dans le prompt tel quel. */
  files: ReadAttachment[] = [],
): Promise<ChiffrageRequest> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY absent — extraction email impossible');
  }

  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    thinking: THINKING,
    system: CHIFFRAGE_PROMPT,
    messages: [
      {
        role: 'user',
        content:
          `De: ${email.from}\nObjet: ${email.subject}\n\n${email.body}` +
          describeFiles(files) +
          attachmentsToPrompt(files),
      },
    ],
  } as any);

  const extracted = parseJsonResponse<ChiffrageExtraction>(msg);

  if (extracted.is_chiffrage_request === false) {
    throw new Error(`Ce mail n'est pas une demande de chiffrage — ${str(extracted.summary)}`);
  }

  const lines: ChiffrageLine[] = (extracted.lines || [])
    .map(l => ({
      reference: str(l.reference),
      designation: str(l.designation),
      material: str(l.material),
      quantity: str(l.quantity),
      comment: str(l.comment),
    }))
    // Une ligne entièrement vide n'apprend rien et encombrerait le dossier.
    .filter(l => l.reference || l.designation || l.material || l.quantity);

  // Des liens de partage sans contenu lisible, c'est une demande dont le fond
  // reste à ouvrir à la main: on le dit, même si le modèle ne l'a pas vu.
  const links = findSharingLinks(email.body || '');
  const unreadable = files.filter(f => !f.text.trim() && f.kind !== 'step' && f.kind !== 'image');

  const request: ChiffrageRequest = {
    reference: str(extracted.reference) || fallbackReference(email),
    client: str(extracted.client),
    lines,
    summary: str(extracted.summary),
    detailsInAttachments:
      extracted.details_in_attachments === true || links.length > 0 || unreadable.length > 0,
    links,
  };

  logger.info(
    {
      reference: request.reference,
      client: request.client,
      lineCount: lines.length,
      detailsInAttachments: request.detailsInAttachments,
      fileCount: files.length,
      linkCount: links.length,
    },
    'Demande de chiffrage extraite',
  );

  return request;
}

/**
 * Quand le mail ne porte aucune référence, on en fabrique une stable à partir
 * de l'identifiant Gmail: deux passages du même message doivent retomber sur
 * la même demande, sinon un rejeu créerait un doublon.
 */
function fallbackReference(email: InboundEmail): string {
  const id = str(email.messageId).slice(0, 10);
  if (id) return `DEM-${id}`;
  const subject = str(email.subject).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 24);
  return subject ? `DEM-${subject}` : 'DEM-SANS-REFERENCE';
}

/**
 * L'inventaire des pièces jointes, y compris celles qu'on n'a pas su lire.
 * Le modèle doit savoir qu'un plan existe même quand son contenu manque:
 * c'est la différence entre « demande sans pièces » et « pièces à ouvrir ».
 */
function describeFiles(files: ReadAttachment[]): string {
  if (files.length === 0) return '';
  const lignes = files.map(f => {
    const etat = f.text.trim()
      ? 'contenu lu ci-dessous'
      : f.kind === 'step'
        ? 'modèle 3D, analysé séparément'
        : f.note || 'non lu';
    return `- ${f.name} (${f.kind}, ${Math.round((f.size || 0) / 1024)} ko) — ${etat}`;
  });
  return `\n\n--- PIÈCES JOINTES AU MAIL ---\n${lignes.join('\n')}`;
}
