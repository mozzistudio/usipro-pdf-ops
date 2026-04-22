import { Router, Request, Response } from 'express';
import { PDFDocument, rgb } from 'pdf-lib';
import { logger } from '../utils/logger';

interface CorrectionZone {
  x_percent: number;
  y_percent: number;
  width_percent: number;
  height_percent: number;
}

interface CorrectionRequest {
  pdfBase64: string;
  pageIndex: number;
  zones: CorrectionZone[];
  prompt?: string;
}

interface AICorrectionResult {
  analysis: string;
  corrections: Array<{
    type: string;
    description: string;
    zone: CorrectionZone;
  }>;
  redraw_table?: boolean;
  table_zone?: CorrectionZone;
  cartouche_overrides?: Record<string, string>;
}

/**
 * Renders a single PDF page to a PNG buffer using @napi-rs/canvas.
 * Returns null if the library is not available.
 */
async function renderPageToPng(
  pdfBytes: Buffer,
  pageIndex: number,
): Promise<Buffer | null> {
  try {
    // Dynamic import — optional dependency
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as any);
    const { createCanvas } = await import('@napi-rs/canvas' as any);

    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 2.0 });

    const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
    const ctx = canvas.getContext('2d');

    await page.render({
      canvasContext: ctx as any,
      viewport: vp,
    }).promise;

    return canvas.toBuffer('image/png') as Buffer;
  } catch {
    return null;
  }
}

/**
 * Calls Claude Vision to analyze zones on a PDF page and return correction instructions.
 */
async function analyzeWithAI(
  pagePng: Buffer | null,
  zones: CorrectionZone[],
  prompt: string,
): Promise<AICorrectionResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { CLAUDE_MODEL } = await import('./claudeModel');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('NO_API_KEY');

  const client = new Anthropic({ apiKey });

  const systemPrompt = `Tu es un assistant spécialisé dans la correction de plans techniques PDF anonymisés pour USI-PRO.

L'utilisateur te montre une page de plan technique avec des zones sélectionnées (rectangles rouges) et décrit un problème.

Ton travail:
1. Analyser l'image et le prompt utilisateur
2. Détecter les problèmes (noms/logos clients non masqués, tables mal positionnées, etc.)
3. Retourner des instructions de correction en JSON

Format de réponse STRICTEMENT JSON (pas de markdown, pas d'explication):
{
  "analysis": "Description courte du problème détecté",
  "corrections": [
    {
      "type": "mask",
      "description": "Ce qui est masqué",
      "zone": {
        "x_percent": 0.0-1.0,
        "y_percent": 0.0-1.0,
        "width_percent": 0.0-1.0,
        "height_percent": 0.0-1.0
      }
    }
  ],
  "redraw_table": false,
  "table_zone": null,
  "cartouche_overrides": null
}

Règles:
- Les coordonnées sont en pourcentage de la page (0.0 à 1.0)
- type peut être "mask" (rectangle blanc) ou "redact" (rectangle noir)
- Si la table USI-PRO doit être redessinée, mettre redraw_table: true et indiquer table_zone
- cartouche_overrides: { "designation": "...", "material": "..." } si des données doivent changer
- Retourner UNIQUEMENT du JSON valide`;

  const userContent: any[] = [];

  // Add image if available
  if (pagePng) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: pagePng.toString('base64'),
      },
    });
  }

  // Add zones info + prompt
  const zonesDesc = zones
    .map(
      (z, i) =>
        `Zone ${i + 1}: x=${(z.x_percent * 100).toFixed(1)}%, y=${(z.y_percent * 100).toFixed(1)}%, ` +
        `largeur=${(z.width_percent * 100).toFixed(1)}%, hauteur=${(z.height_percent * 100).toFixed(1)}%`,
    )
    .join('\n');

  userContent.push({
    type: 'text',
    text: `Zones sélectionnées par l'utilisateur:\n${zonesDesc}\n\nDemande de correction: ${prompt || 'Masquer les zones sélectionnées'}`,
  });

  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();
  const json = JSON.parse(raw.replace(/^```json?\n?/, '').replace(/\n?```$/, ''));
  return json as AICorrectionResult;
}

/**
 * Applies white rectangles at the given percent-based zones on a specific PDF page.
 */
async function applyZoneMasks(
  pdfBytes: Buffer,
  pageIndex: number,
  zones: CorrectionZone[],
): Promise<Buffer> {
  const doc = await PDFDocument.load(pdfBytes);
  const page = doc.getPage(pageIndex);
  const { width, height } = page.getSize();

  for (const z of zones) {
    const x = z.x_percent * width;
    const y = (1 - z.y_percent - z.height_percent) * height; // Convert top-origin to bottom-origin
    const w = z.width_percent * width;
    const h = z.height_percent * height;

    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      color: rgb(1, 1, 1), // white
    });
  }

  return Buffer.from(await doc.save());
}

/**
 * Registers the POST /api/correct-page endpoint on the given router.
 */
export function registerCorrectPageEndpoint(router: Router): void {
  router.post('/api/correct-page', async (req: Request, res: Response) => {
    const { pdfBase64, pageIndex, zones, prompt } = req.body as CorrectionRequest;

    if (!pdfBase64 || pageIndex == null || !Array.isArray(zones)) {
      res.status(400).json({ error: 'pdfBase64, pageIndex et zones sont requis' });
      return;
    }

    try {
      const pdfBytes = Buffer.from(pdfBase64, 'base64');
      const apiKey = process.env.ANTHROPIC_API_KEY;

      let analysis = '';
      let corrections: AICorrectionResult['corrections'] = [];
      let zonesToApply = zones;

      // Try AI analysis if API key is available and user provided a prompt
      if (apiKey && prompt) {
        try {
          const pagePng = await renderPageToPng(pdfBytes, pageIndex);
          const aiResult = await analyzeWithAI(pagePng, zones, prompt);
          analysis = aiResult.analysis;
          corrections = aiResult.corrections || [];

          // Use AI-suggested zones if available, otherwise use user zones
          if (corrections.length > 0) {
            zonesToApply = corrections
              .filter((c) => c.type === 'mask' || c.type === 'redact')
              .map((c) => c.zone);
            // Also include user-drawn zones
            zonesToApply = [...zones, ...zonesToApply];
          }
        } catch (aiErr: any) {
          logger.warn({ err: aiErr.message }, 'AI correction failed, falling back to manual zones');
          analysis = 'Correction IA indisponible — zones manuelles appliquées';
        }
      } else {
        analysis = 'Zones manuelles appliquées (pas de prompt IA)';
      }

      // Apply white rectangles on the zones
      const modified = await applyZoneMasks(pdfBytes, pageIndex, zonesToApply);

      res.json({
        pdfBase64: modified.toString('base64'),
        analysis,
        corrections,
      });
    } catch (err: any) {
      logger.error({ err: err.message }, 'correct-page failed');
      res.status(500).json({ error: 'Échec de la correction de page' });
    }
  });
}
