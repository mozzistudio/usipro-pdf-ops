/**
 * PDF Anonymizer — Node.js / pdf-lib implementation of the CLAUDE.md pipeline.
 *
 * For each PDF:
 *  1. Extract text (pdf-parse) to detect client format + extract cartouche data
 *  2. Apply white rectangles over the proprietary cartouche zones (pdf-lib)
 *  3. Draw USI-PRO branded data table inside the masked zone
 *  4. Strip metadata
 *
 * Coordinate note:
 *   CLAUDE.md / fitz  →  top-left origin, Y increases downward
 *   pdf-lib           →  bottom-left origin, Y increases upward
 *
 *   Conversion for fitz rect (x0, y0, x1, y1):
 *     lib.x      = x0
 *     lib.y      = pageHeight - y1   ← bottom edge of the fitz rect
 *     lib.width  = x1 - x0
 *     lib.height = y1 - y0
 */

import { PDFDocument, PDFImage, PDFPage, rgb, StandardFonts } from 'pdf-lib';
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require('pngjs') as { PNG: any };

// ── pdf2json text extraction ──────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFParser = require('pdf2json');

async function extractTextFromPdf(pdfBytes: Buffer): Promise<string> {
  return new Promise((resolve) => {
    try {
      const parser = new PDFParser(null, 1); // 1 = raw text mode
      parser.on('pdfParser_dataError', () => resolve(''));
      parser.on('pdfParser_dataReady', () => {
        try {
          const raw = parser.getRawTextContent() as string;
          resolve(raw || '');
        } catch {
          resolve('');
        }
      });
      parser.parseBuffer(pdfBytes);
    } catch {
      resolve('');
    }
  });
}

// ── Colors ───────────────────────────────────────────────────────
const WHITE      = rgb(1, 1, 1);
const NAVY       = rgb(15 / 255, 26 / 255, 46 / 255);  // #0f1a2e — same as app navbar
const TEAL_DARK  = rgb(0.16, 0.42, 0.39);   // darker teal for borders/labels
const TEAL_LIGHT = rgb(0.90, 0.97, 0.96);   // pale teal tint for row backgrounds
const TEAL_TINT  = rgb(0.95, 0.99, 0.98);   // very pale tint for value cells
const RED        = rgb(0.86, 0.15, 0.15);
const GRAY       = rgb(0.55, 0.60, 0.62);
const BORDER_CLR = rgb(0.80, 0.88, 0.87);   // soft teal-gray border
const TEXT_CLR   = rgb(0.12, 0.16, 0.18);

// ── Logo cache ───────────────────────────────────────────────────
let _logoPngCache: Buffer | null | undefined = undefined; // undefined = not yet loaded

function getLogoPng(): Buffer | null {
  if (_logoPngCache !== undefined) return _logoPngCache;
  try {
    const p = path.join(__dirname, '../../public/logo.png');
    const raw = fs.readFileSync(p);
    // pngjs decodes any PNG (including palette/indexed) to RGBA
    const decoded = PNG.sync.read(raw);
    const rgba = new PNG({ width: decoded.width, height: decoded.height, filterType: -1 });
    rgba.data = decoded.data;
    _logoPngCache = PNG.sync.write(rgba) as Buffer;
    return _logoPngCache;
  } catch {
    _logoPngCache = null;
    return null;
  }
}

// ── Format descriptor ────────────────────────────────────────────
interface Fmt {
  key: string;
  /** Mask zones in fitz coords [x0, y0, x1, y1] (top-left origin) */
  zones: [number, number, number, number][];
}

// ── Cartouche data ───────────────────────────────────────────────
interface CartoucheData {
  designation: string;
  material: string;
  applicableStd: string;
  finish: string;
}

// ── Format detection ─────────────────────────────────────────────
const SIGS: Record<string, string[]> = {
  ETUDEMA:    ['ETUDEMA'],
  TURBOMECA:  ['TURBOMECA', 'SAFRAN', 'SAFDIN'],
  DELONCA:    ['DELONCA'],
  MUQUANS:    ['MUQUANS', 'IXBLUE', 'EXAIL', 'iXblue'],
  AZURLIGHT:  ['AZURLIGHT', 'F9670'],
  SNP2I:      ['SNP2I', 'SNP2i'],
  INGETEP:    ['INGETEP'],
  ALPHANOV:   ['ALPHANOV'],
  CYBERIA:    ['CYBERIA', 'MAUGUIO'],
  PRANA:      ['PRANA', 'PRÂNA'],
  SOLIDWORKS: ['SOLIDWORKS'],
};

function near(a: number, b: number, tol = 30): boolean {
  return Math.abs(a - b) < tol;
}

function detect(text: string, w: number, h: number): Fmt {
  const t = text.toUpperCase();
  const has = (sigs: string[]) => sigs.some((s) => t.includes(s.toUpperCase()));

  if (has(SIGS.ETUDEMA))
    return { key: 'ETUDEMA_A2', zones: [[1125, 915, w, h]] };

  // INGETEP must be checked before TURBOMECA — INGETEP drawings often
  // reference SAFDIN/SAFRAN as the customer, which would falsely trigger
  // the TURBOMECA format and apply wrong (too aggressive) masking zones.
  if (has(SIGS.INGETEP)) {
    // A1: ~2384 x 1684 — cartouche occupies bottom-right ~35% width × ~15% height
    if (near(w, 2384) && near(h, 1684))
      return { key: 'INGETEP_A1', zones: [[1550, 1440, w, h]] };
    // A2: ~1684 x 1191
    if (near(w, 1684) && near(h, 1191))
      return { key: 'INGETEP_A2', zones: [[1095, 1010, w, h]] };
    // A3: ~1191 x 842
    if (near(w, 1191) && near(h, 842))
      return { key: 'INGETEP_A3', zones: [[775, 715, w, h]] };
    // Generic fallback — proportional to A1 reference ratios
    const cx = Math.round(w * 0.65);
    const cy = Math.round(h * 0.855);
    return { key: 'INGETEP_GENERIC', zones: [[cx, cy, w, h]] };
  }

  if (has(SIGS.TURBOMECA)) {
    if (near(w, 2384) && near(h, 1684))
      return { key: 'TURBOMECA_A1', zones: [[1060, 0, w, 170], [1296, 1020, w, h]] };
    if (near(w, 1684) && near(h, 1191))
      return { key: 'TURBOMECA_A2', zones: [[780, 0, w, 85], [1140, 860, w, h]] };
    return { key: 'TURBOMECA_A3', zones: [[530, 0, w, 85], [648, 510, w, h]] };
  }

  if (has(SIGS.DELONCA)) {
    if (near(w, 1684) && near(h, 1191))
      return { key: 'DELONCA_A2', zones: [[1595, 925, 1660, 1005], [1120, 1078, 1660, h]] };
    return { key: 'DELONCA_A3', zones: [[1105, 608, 1170, 655], [628, 728, 1170, h]] };
  }

  if (has(SIGS.MUQUANS)) {
    if (h > w)
      return { key: 'MUQUANS_A4', zones: [[35, 698, w, h]] };
    return { key: 'MUQUANS_A3', zones: [[635, 698, w, h]] };
  }

  if (has(SIGS.AZURLIGHT)) {
    if (near(w, 842) && near(h, 595))
      return { key: 'AZURLIGHT_A3S', zones: [[0, 0, 42, h], [815, 0, w, h], [565, 400, w, h]] };
    return { key: 'AZURLIGHT_A3', zones: [[0, 0, 55, h], [1155, 0, w, h], [805, 555, w, h], [0, h - 30, 120, h]] };
  }

  if (has(SIGS.SNP2I))
    return { key: 'SNP2I_A3', zones: [[480, 720, w, h]] };

  if (has(SIGS.ALPHANOV))
    return { key: 'ALPHANOV_A3', zones: [[555, 718, w, h]] };

  if (has(SIGS.CYBERIA)) {
    if (h > w && h > 1100)
      return { key: 'CYBERIA_A3H', zones: [[0, 700, 420, h]] };
    return { key: 'CYBERIA_A4V', zones: [[0, 640, w, h]] };
  }

  if (has(SIGS.PRANA))
    return { key: 'PRANA_A4', zones: [[0, 0, 60, h], [60, 700, w, h]] };

  if (has(SIGS.SOLIDWORKS))
    return { key: 'SOLIDWORKS_A4', zones: [[440, 420, w, h]] };

  // Generic fallback — bottom 22% of page
  const gy0 = Math.round(h * 0.78);
  return { key: 'GENERIC', zones: [[0, gy0, w, h]] };
}

// ── Coordinate conversion (fitz → pdf-lib) ───────────────────────
function fitRect(
  x0: number, y0: number, x1: number, y1: number,
  pageW: number, pageH: number,
) {
  const cx0 = Math.max(0, Math.min(x0, pageW));
  const cy0 = Math.max(0, Math.min(y0, pageH));
  const cx1 = Math.max(0, Math.min(x1, pageW));
  const cy1 = Math.max(0, Math.min(y1, pageH));
  return {
    x: cx0,
    y: pageH - cy1,
    width: cx1 - cx0,
    height: cy1 - cy0,
  };
}

// ── Refinement prompt interpretation via Claude ──────────────────
async function applyRefinementOverrides(
  prompt: string,
  current: CartoucheData,
): Promise<Partial<CartoucheData>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Fallback: simple KEY = VALUE regex if no API key configured
  if (!apiKey) {
    const overrides: Partial<CartoucheData> = {};
    const pairs: [RegExp, keyof CartoucheData][] = [
      [/(?:d[eé]signation|designation|title|intitul[eé])\s*[=:]\s*([^,;\n]+)/i, 'designation'],
      [/(?:mati[eè]re|mat[eé]riau|material)\s*[=:]\s*([^,;\n]+)/i,             'material'],
      [/(?:finition|finish|[eé]tat surface|traitement surface)\s*[=:]\s*([^,;\n]+)/i, 'finish'],
      [/(?:norme|standard|applicable std|iso)\s*[=:]\s*([^,;\n]+)/i,            'applicableStd'],
    ];
    for (const [pat, field] of pairs) {
      const m = prompt.match(pat);
      if (m?.[1]) overrides[field] = m[1].trim();
    }
    return overrides;
  }

  // Use Claude to interpret free-text feedback and produce structured overrides
  try {
    const client = new Anthropic({ apiKey });
    const systemPrompt = `You are a PDF cartouche data editor for a technical drawing anonymization system.
The user provides feedback in any language (French/English) about a technical drawing PDF cartouche.
Your job: extract any intended field overrides from their feedback and return ONLY a JSON object.

Fields available (all optional, omit if not mentioned or inferrable):
- "designation": part name / drawing title
- "material": material name (translate to English if in French)
- "finish": surface finish or treatment (translate to English)
- "applicableStd": applicable standard (e.g. ISO 2768 mK)

Rules:
- Return ONLY valid JSON, no explanation, no markdown fences
- Omit fields not mentioned in the feedback
- If the feedback is purely about layout/visual issues (e.g. "you cut the drawing"), return {}
- Translate material/finish values to English
- Example output: {"designation":"SUPPORT OPTIQUE","material":"STAINLESS STEEL 316L"}`;

    const userMsg = `Current cartouche data:
${JSON.stringify(current, null, 2)}

User feedback: "${prompt}"

Return JSON overrides:`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });

    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    const json = JSON.parse(raw.replace(/^```json?\n?/, '').replace(/\n?```$/, ''));
    return json as Partial<CartoucheData>;
  } catch (err) {
    console.error('[pdfAnonymizer] refinement LLM failed:', err);
    return {};
  }
}

// ── Cartouche data extraction ────────────────────────────────────
const TRANSLATIONS: Record<string, string> = {
  'anodisation incolore': 'CLEAR ANODIZING',
  'anodisation noire': 'BLACK ANODIZING',
  'brut': 'RAW',
  'sablé': 'SANDBLASTED',
  'sable': 'SANDBLASTED',
  'peint': 'PAINTED',
  'traitement thermique': 'HEAT TREATED',
  'acier inoxydable': 'STAINLESS STEEL',
  'laiton': 'BRASS',
  'cuivre': 'COPPER',
  'aluminium': 'ALUMINUM',
};

function translate(val: string): string {
  const lower = val.toLowerCase().trim();
  for (const [fr, en] of Object.entries(TRANSLATIONS)) {
    if (lower.includes(fr)) return val.replace(new RegExp(fr, 'gi'), en);
  }
  return val;
}

function extractCartoucheData(text: string): CartoucheData {
  const extract = (patterns: RegExp[]): string => {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m && m[1]) {
        const v = m[1].trim().replace(/\s+/g, ' ');
        if (v.length > 0 && v !== '—' && v.length < 80) {
          return translate(v);
        }
      }
    }
    return '—';
  };

  const designation = extract([
    /PART\s*:\s*(.+)/i,
    /d[eé]signation\s*[:\-]\s*(.+)/i,
    /designation\s*[:\-]\s*(.+)/i,
    /intitul[eé]\s*[:\-]\s*(.+)/i,
    /title\s*[:\-]\s*(.+)/i,
    /nom\s+pi[eè]ce\s*[:\-]\s*(.+)/i,
    /libell[eé]\s*[:\-]\s*(.+)/i,
  ]);

  const material = extract([
    /mati[eè]re\s*[:\-]\s*(.+)/i,
    /mat[eé]riau\s*[:\-]\s*(.+)/i,
    /mat\.\s*[:\-]?\s*(.+)/i,
    /material\s*[:\-]\s*(.+)/i,
    /(EN-AW\s*\d{4}[A-Z]?)/i,
    /(INOX\s*\d+[A-Z]?)/i,
    /(7075[^-\s]*|6061[^-\s]*|2017[^-\s]*|316L[^-\s]*)/i,
  ]);

  const applicableStd = extract([
    /GEN\s*TOL\s*:\s*(.+)/i,
    /tol[eé]rances?\s*g[eé]n[eé]rales?\s*[:\-]?\s*(ISO\s*\d+[^\n\r]*)/i,
    /(ISO\s*2768[\s\-][^\n\r]{1,20})/i,
    /(ISO\s*\d{4}[\s\-][^\n\r]{1,20})/i,
    /norme\s*[:\-]\s*(.+)/i,
    /tol[eé]rance\s*[:\-]\s*(.+)/i,
  ]);

  const finish = extract([
    /finition\s*[:\-]\s*(.+)/i,
    /[eé]tat\s+de\s+surface\s*[:\-]\s*(.+)/i,
    /rugosit[eé]\s*[:\-]\s*(.+)/i,
    /([Rr]a\s*[\d.,]+\s*(?:µm|um))/,
    /finish\s*[:\-]\s*(.+)/i,
    /traitement\s+de\s+surface\s*[:\-]\s*(.+)/i,
  ]);

  return { designation, material, applicableStd, finish };
}

// ── USI-PRO table drawing ────────────────────────────────────────
// Layout (full zone width, 3 sections):
//
//  +──────────────+──────────────────────────+════════════════════+
//  │  PLAN_ID     │ DRAWING NO.  │ plan_id   ║                    ║
//  │  (large red) │──────────────┼───────────║  DARK BLUE BANNER  ║
//  │              │ DESIGNATION  │ —         ║   (bottom-right)   ║
//  │  lot_id      │──────────────┼───────────║                    ║
//  │  (small)     │ MATERIAL     │ —         ║   [logo + tagline] ║
//  │              │──────────────┼───────────║                    ║
//  │              │ APPLICABLE   │ —         ║                    ║
//  │              │──────────────┼───────────║                    ║
//  │              │ FINISH       │ —         ║                    ║
//  +──────────────+──────────────────────────+════════════════════+
//
async function drawUsIproTable(
  page: PDFPage,
  zone: { x: number; y: number; width: number; height: number },
  planId: string,
  lotId: string,
  data: CartoucheData,
  logoImg: PDFImage | null,
  fonts: { reg: any; bold: any },
): Promise<void> {
  const { x: zx, y: zy, width: zw, height: zh } = zone;

  // ── Auto size: fixed column widths, right-anchored ────────────
  const NUM_ROWS = 5;
  const ROW_H    = 14;     // pt — compact fixed row height
  const th       = NUM_ROWS * ROW_H;   // ~70pt table height
  const ty       = zy;     // bottom anchor (pdf-lib: y grows up)

  // Fixed column widths — sized to content, not page
  const ID_W     = 100;    // pt
  const BANNER_W = 150;    // pt
  const DATA_W   = 290;    // pt
  const tw       = ID_W + DATA_W + BANNER_W;  // total table width = 540pt

  const LABEL_W  = DATA_W * 0.40;
  const VALUE_W  = DATA_W - LABEL_W;

  // Right-anchor within the masked zone
  const txStart  = zx + zw - tw;   // table left edge
  const xId      = txStart;
  const xData    = txStart + ID_W;
  const xLabel   = xData;
  const xValue   = xData + LABEL_W;
  const xBanner  = xData + DATA_W;

  // Font sizes — based on fixed ROW_H
  const labelFs  = 5.2;
  const valueFs  = 6.0;
  const planFs   = 9.5;
  const lotFs    = 5.0;
  const tagFs    = 4.5;

  // ── White fill for entire masked zone ─────────────────────────
  page.drawRectangle({ x: zx, y: zy, width: zw, height: zh, color: WHITE, borderWidth: 0 });

  // ── Outer border (table only — auto-width, right-anchored) ────
  page.drawRectangle({
    x: txStart, y: ty, width: tw, height: th,
    borderColor: TEAL_DARK, borderWidth: 1,
    color: undefined,
  });

  // ── Vertical divider between ID column and data section ───────
  page.drawLine({
    start: { x: xData, y: ty },
    end:   { x: xData, y: ty + th },
    color: TEAL_DARK, thickness: 1,
  });

  // ── Vertical divider between data section and logo banner ─────
  page.drawLine({
    start: { x: xBanner, y: ty },
    end:   { x: xBanner, y: ty + th },
    color: TEAL_DARK, thickness: 1,
  });

  // ── ID column: PLAN_ID (large red) + lot_id (small gray) ──────
  const padId = Math.max(3, ID_W * 0.08);
  // lot_id — upper area
  page.drawText(lotId, {
    x: xId + padId,
    y: ty + th * 0.72,
    size: lotFs,
    font: fonts.bold,
    color: GRAY,
  });
  // plan_id — vertically centered
  page.drawText(planId, {
    x: xId + padId,
    y: ty + th * 0.38,
    size: planFs,
    font: fonts.bold,
    color: RED,
  });

  // ── Data rows ─────────────────────────────────────────────────
  const fields: [string, string][] = [
    ['DRAWING NO.', planId],
    ['DESIGNATION', data.designation],
    ['MATERIAL',    data.material],
    ['APPLICABLE STD', data.applicableStd],
    ['FINISH',      data.finish],
  ];

  for (let i = 0; i < NUM_ROWS; i++) {
    const [label, value] = fields[i];
    // Rows from top to bottom (highest Y first in pdf-lib)
    const rowTop    = ty + th - i * ROW_H;
    const rowBottom = rowTop - ROW_H;
    const textY     = rowBottom + ROW_H * 0.28;

    // Row separator
    if (i > 0) {
      page.drawLine({
        start: { x: xData,   y: rowTop },
        end:   { x: xBanner, y: rowTop },
        color: BORDER_CLR, thickness: 0.5,
      });
    }

    // Label cell background
    page.drawRectangle({
      x: xLabel, y: rowBottom, width: LABEL_W, height: ROW_H,
      color: i === 0 ? TEAL_DARK : TEAL_LIGHT,
      borderWidth: 0,
    });

    // Label / value column separator
    page.drawLine({
      start: { x: xValue, y: rowBottom },
      end:   { x: xValue, y: rowTop },
      color: BORDER_CLR, thickness: 0.5,
    });

    // Value cell background
    page.drawRectangle({
      x: xValue, y: rowBottom, width: VALUE_W, height: ROW_H,
      color: i === 0 ? TEAL_TINT : WHITE,
      borderWidth: 0,
    });

    // Label text
    page.drawText(label, {
      x: xLabel + Math.max(3, LABEL_W * 0.04),
      y: textY,
      size: labelFs,
      font: fonts.bold,
      color: i === 0 ? WHITE : TEAL_DARK,
    });

    // Value text — clamp to avoid overflow
    const maxChars = Math.floor(VALUE_W / (valueFs * 0.58));
    const display  = value.length > maxChars ? value.substring(0, maxChars - 1) + '…' : value;
    page.drawText(display, {
      x: xValue + Math.max(3, VALUE_W * 0.02),
      y: textY,
      size: i === 0 ? valueFs * 1.05 : valueFs,
      font: i === 0 ? fonts.bold : fonts.reg,
      color: i === 0 ? RED : (value === '—' ? GRAY : TEXT_CLR),
    });
  }

  // ── Dark blue banner (bottom-right) ───────────────────────────
  page.drawRectangle({
    x: xBanner, y: ty, width: BANNER_W, height: th,
    color: NAVY, borderWidth: 0,
  });

  // Logo centered in banner
  if (logoImg) {
    const logoDims = logoImg.scale(1);
    const aspect   = logoDims.width / logoDims.height;
    const maxW     = BANNER_W - Math.max(6, BANNER_W * 0.10);
    const maxH     = th * 0.52;
    let lw = Math.min(maxW, maxH * aspect);
    let lh = lw / aspect;
    const lx = xBanner + (BANNER_W - lw) / 2;
    const ly = ty + th * 0.38;
    page.drawImage(logoImg, { x: lx, y: ly, width: lw, height: lh });
  } else {
    // Text fallback
    page.drawText('USI-PRO', {
      x: xBanner + BANNER_W * 0.12,
      y: ty + th * 0.48,
      size: 9,
      font: fonts.bold,
      color: WHITE,
    });
  }

  // Tagline
  const taglineText = 'PRECISION MACHINING';
  const taglineW    = taglineText.length * tagFs * 0.60;
  page.drawText(taglineText, {
    x: xBanner + (BANNER_W - taglineW) / 2,
    y: ty + th * 0.12,
    size: tagFs,
    font: fonts.reg,
    color: rgb(0.65, 0.78, 0.90),
  });

  // Re-draw outer border on top
  page.drawRectangle({
    x: txStart, y: ty, width: tw, height: th,
    borderColor: TEAL_DARK, borderWidth: 1,
    color: undefined,
  });
}

// ── Main export ──────────────────────────────────────────────────
export async function anonymizePdf(
  pdfBytes: Buffer,
  planId: string,
  lotId: string,
  refinementPrompt?: string,
): Promise<{ pdf: Buffer; format: string }> {
  // 1. Extract text (for format detection + cartouche data)
  //    pdf2json (pdf.js-based) handles more PDF types than pdf-parse
  let text = '';
  try {
    text = await extractTextFromPdf(pdfBytes);
  } catch {
    // Scanned PDF — GENERIC will apply, data fields will be '—'
  }

  let cartouche = extractCartoucheData(text);
  // Apply field overrides interpreted from the refinement prompt via Claude
  if (refinementPrompt?.trim()) {
    const overrides = await applyRefinementOverrides(refinementPrompt, cartouche);
    cartouche = { ...cartouche, ...overrides };
  }

  const doc = await PDFDocument.load(pdfBytes);
  const fonts = {
    reg:  await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  const firstPage = doc.getPage(0);
  const { width: w0, height: h0 } = firstPage.getSize();
  const fmt = detect(text, w0, h0);
  console.log(`[anonymizePdf] planId=${planId} format=${fmt.key} size=${Math.round(w0)}x${Math.round(h0)} | desig="${cartouche.designation}" mat="${cartouche.material}"`);

  // 2. Embed logo (once per PDF document)
  let logoImg: PDFImage | null = null;
  try {
    const logoBuf = getLogoPng();
    if (logoBuf) logoImg = await doc.embedPng(logoBuf);
  } catch (e) {
    console.warn('[anonymizePdf] logo embed failed:', e);
  }

  // 3. Process each page
  const pageCount = doc.getPageCount();

  for (let i = 0; i < pageCount; i++) {
    const page = doc.getPage(i);
    const { width: w, height: h } = page.getSize();

    // Apply white masks
    for (const [x0, y0, x1, y1] of fmt.zones) {
      const r = fitRect(x0, y0, x1, y1, w, h);
      if (r.width > 0 && r.height > 0) {
        page.drawRectangle({ ...r, color: WHITE, borderWidth: 0 });
      }
    }

    // Draw USI-PRO table in the main (last) masked zone
    const [mx0, my0, mx1, my1] = fmt.zones[fmt.zones.length - 1];
    const mainZone = fitRect(mx0, my0, mx1, my1, w, h);

    // Only draw table if zone is large enough
    if (mainZone.width > 80 && mainZone.height > 30) {
      await drawUsIproTable(page, mainZone, planId, lotId, cartouche, logoImg, fonts);
    }
  }

  // 4. Strip metadata
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setCreator('USI-PRO');
  doc.setProducer('USI-PRO');

  return { pdf: Buffer.from(await doc.save()), format: fmt.key };
}
