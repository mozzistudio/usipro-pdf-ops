import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL } from './claudeModel';
import { renderPageToPng } from './renderPdfPage';
import { logger } from '../utils/logger';

export interface PlanCandidate {
  name: string;
  pathDisplay: string;
  pdfBytes: Buffer;
}

export interface PlanSelection {
  selectedIndex: number;
  confidence: 'high' | 'low';
  reason: string;
  thumbnails: Array<Buffer | null>;
}

const SYSTEM_PROMPT = `Tu vois N images — les premières pages de N PDFs candidats pour un dossier d'usinage.
Identifie lequel est le plan technique (dessin avec vues, cotations, dimensions, cartouche),
par opposition à une fiche, un bon de livraison, une liste de specs texte, etc.
Retourne STRICTEMENT un JSON: {"choice": <1..N>, "confidence": "high" | "low", "reason": "..."}
Pas de markdown, pas d'explication hors JSON.`;

/**
 * Pick the most plan-like PDF among several candidates using Claude Vision.
 * Returns the 0-based index of the chosen candidate, a confidence level, and
 * the rendered first-page thumbnails (null for candidates that failed to render).
 *
 * Fallback behavior:
 *  - If 0 candidates rendered successfully → confidence 'low', index 0.
 *  - If Claude API key is missing or the call fails → confidence 'low', index 0.
 *  - If Claude's JSON can't be parsed → confidence 'low', index 0.
 */
export async function selectPlanPdf(candidates: PlanCandidate[]): Promise<PlanSelection> {
  if (candidates.length === 0) {
    throw new Error('selectPlanPdf called with no candidates');
  }
  if (candidates.length === 1) {
    const thumb = await renderPageToPng(candidates[0].pdfBytes, 0, 1.0);
    return { selectedIndex: 0, confidence: 'high', reason: 'single candidate', thumbnails: [thumb] };
  }

  const thumbnails = await Promise.all(
    candidates.map(c => renderPageToPng(c.pdfBytes, 0, 1.0)),
  );

  const renderable = thumbnails
    .map((png, i) => ({ png, i }))
    .filter((e): e is { png: Buffer; i: number } => e.png !== null);

  if (renderable.length === 0) {
    logger.warn('selectPlanPdf: no candidate could be rendered — falling back to manual selection');
    return { selectedIndex: 0, confidence: 'low', reason: 'no rendered thumbnail', thumbnails };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('selectPlanPdf: ANTHROPIC_API_KEY not set — falling back to manual selection');
    return { selectedIndex: 0, confidence: 'low', reason: 'missing ANTHROPIC_API_KEY', thumbnails };
  }

  try {
    const client = new Anthropic({ apiKey });
    const content: any[] = [];
    renderable.forEach((e, displayIdx) => {
      content.push({
        type: 'text',
        text: `Image ${displayIdx + 1} — fichier: ${candidates[e.i].name}`,
      });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: e.png.toString('base64'),
        },
      });
    });
    content.push({
      type: 'text',
      text: `Choisis l'image qui représente le plan technique. Réponds en JSON {"choice": <1..${renderable.length}>, "confidence": "high"|"low", "reason": "..."}.`,
    });

    const msg = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });

    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    const cleaned = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(cleaned) as {
      choice: number;
      confidence: 'high' | 'low';
      reason?: string;
    };

    const displayChoice = Number(parsed.choice);
    if (!Number.isFinite(displayChoice) || displayChoice < 1 || displayChoice > renderable.length) {
      logger.warn({ raw }, 'selectPlanPdf: Claude returned out-of-range choice');
      return {
        selectedIndex: 0,
        confidence: 'low',
        reason: 'choice out of range',
        thumbnails,
      };
    }

    const selectedIndex = renderable[displayChoice - 1].i;
    const confidence: 'high' | 'low' = parsed.confidence === 'high' ? 'high' : 'low';
    logger.info(
      {
        candidateCount: candidates.length,
        renderedCount: renderable.length,
        choice: displayChoice,
        selectedIndex,
        confidence,
        reason: parsed.reason,
      },
      'selectPlanPdf: Claude picked a candidate',
    );

    return {
      selectedIndex,
      confidence,
      reason: parsed.reason || '',
      thumbnails,
    };
  } catch (err: any) {
    logger.warn({ err: err.message }, 'selectPlanPdf: Claude call failed — falling back to manual selection');
    return { selectedIndex: 0, confidence: 'low', reason: `claude error: ${err.message}`, thumbnails };
  }
}
