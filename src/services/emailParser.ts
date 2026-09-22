import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL, THINKING, parseJsonResponse } from './claudeModel';
import { FormPayload, Part } from '../types';
import { logger } from '../utils/logger';

/** An inbound email as forwarded by the Apps Script bridge. */
export interface InboundEmail {
  from: string;
  subject: string;
  body: string;
  /** Gmail message id — used to recognize a replayed message, not for parsing. */
  messageId?: string;
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
