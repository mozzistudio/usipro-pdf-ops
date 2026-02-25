import PDFDocument from 'pdfkit';
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  ImageRun,
  WidthType,
  AlignmentType,
  BorderStyle,
  VerticalAlign,
  TableLayoutType,
  ShadingType,
} from 'docx';
import * as fs from 'fs';
import * as path from 'path';
import { Part } from '../types';
import { formatDateFR } from '../utils/helpers';
import { ofLogger } from '../utils/logger';

// ─── Logo helper ────────────────────────────────────────────────────────────

const LOGO_PATHS = [
  path.resolve(__dirname, '../../assets/logo.png'),
  path.resolve(__dirname, '../../assets/logo.jpg'),
  path.resolve(__dirname, '../../assets/logo.jpeg'),
];

function loadLogo(): Buffer | null {
  for (const p of LOGO_PATHS) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p);
    } catch { /* ignore */ }
  }
  return null;
}

// ─── Company constants ──────────────────────────────────────────────────────

const COMPANY = {
  name: 'USI-PRO',
  address: '13 Rte de Citon C\u00e9nac, 33670 Sadirac',
  email: 'accueil@usi-pro.com',
  phone: '05 47 74 15 12',
  website: 'www.usi-pro.com',
  legalLine1: 'USI-PRO  |  SARL au capital de 15 000 \u20ac  |  SIRET : 920 812 401 00015',
  legalLine2: 'www.usi-pro.com  |  TVA : FR17920812401',
};

// ─── Theme (USI-PRO brand) ──────────────────────────────────────────────────

const THEME = {
  primary: '#1E2D3D',
  accent: '#3ECDC6',
  headerBg: '#1E2D3D',
  headerText: '#ffffff',
  altRow: '#F8FAFC',
  text: '#1E2D3D',
  textLight: '#4A5568',
  muted: '#6B7280',
  border: '#E0E0E0',
  cardBg: '#F7F8FA',
  cardBorder: '#E8EAED',
  pillTealBg: '#E6FAF9',
  pillGrayBg: '#EDF0F4',
};

// ─── Info cards content ─────────────────────────────────────────────────────

const INFO_CARDS = [
  {
    title: 'DELIVERY TIME',
    body: 'Maximum 18 days after order placement, unless otherwise stated in the comments.',
    boldWord: '18 days',
  },
  {
    title: 'QUESTIONS',
    body: 'Contact us at Accueil@usi-pro.com',
    link: 'Accueil@usi-pro.com',
  },
  {
    title: 'PAYMENT & CURRENCY',
    body: 'Per our usual terms. Accepted currencies: \u20ac or $',
    boldWord: '\u20ac or $',
  },
  {
    title: 'SHIPPING',
    body: 'Shipping can be arranged at your expense and re-invoiced. Please provide an estimated quote in advance.',
  },
];

// ─── PDF Generation (pdfkit) ────────────────────────────────────────────────

function pdfDrawHeader(
  doc: PDFKit.PDFDocument,
  pageWidth: number,
  marginLeft: number,
  contentWidth: number,
): number {
  const headerH = 90;

  // Dark navy header (full bleed)
  doc.save();
  doc.rect(0, 0, pageWidth, headerH).fill(THEME.headerBg);
  // Teal accent bar
  doc.rect(0, headerH, pageWidth, 3).fill(THEME.accent);
  doc.restore();

  // Logo (left side)
  const logoBuffer = loadLogo();
  if (logoBuffer) {
    const logoH = 45;
    const logoY = (headerH - logoH) / 2;
    doc.image(logoBuffer, marginLeft, logoY, { height: logoH });
  } else {
    doc.fontSize(22).font('Helvetica-Bold').fillColor(THEME.headerText)
      .text(COMPANY.name, marginLeft, 32);
  }

  // Company info (right side)
  const infoW = contentWidth;
  let infoY = 22;
  const lineH = 13;
  doc.fontSize(8).font('Helvetica').fillColor(THEME.headerText);
  doc.text(COMPANY.address, marginLeft, infoY, { width: infoW, align: 'right' });
  infoY += lineH;
  doc.text(COMPANY.email, marginLeft, infoY, { width: infoW, align: 'right' });
  infoY += lineH;
  doc.text(COMPANY.phone, marginLeft, infoY, { width: infoW, align: 'right' });
  infoY += lineH;
  doc.text(COMPANY.website, marginLeft, infoY, { width: infoW, align: 'right' });

  return headerH + 3;
}

function pdfDrawPill(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  h: number,
): number {
  doc.font('Helvetica').fontSize(9);
  const tw = doc.widthOfString(text);
  const padH = 12;
  const w = tw + padH * 2;
  const r = h / 2;

  doc.save();
  doc.roundedRect(x, y, w, h, r).strokeColor(THEME.border).lineWidth(1).stroke();
  doc.restore();
  doc.fillColor(THEME.text).text(text, x + padH, y + (h - 9) / 2, { lineBreak: false });

  return w;
}

function pdfDrawSectionLabel(
  doc: PDFKit.PDFDocument,
  label: string,
  x: number,
  y: number,
): void {
  // Horizontal line
  doc.save();
  doc.moveTo(x, y).lineTo(x + 515, y)
    .strokeColor(THEME.border).lineWidth(0.8).stroke();
  doc.restore();

  // White background behind label
  doc.font('Helvetica-Bold').fontSize(8);
  const lw = doc.widthOfString(label);
  const lx = x + 16;
  doc.save();
  doc.rect(lx - 6, y - 5, lw + 12, 10).fill('#ffffff');
  doc.restore();

  // Label text
  doc.fillColor(THEME.accent).text(label, lx, y - 4, { lineBreak: false });
}

function pdfDrawTableHeader(
  doc: PDFKit.PDFDocument,
  headers: string[],
  colWidths: number[],
  tableX: number,
  y: number,
  rowH: number,
): number {
  const totalW = colWidths.reduce((a, b) => a + b, 0);

  // Teal top accent
  doc.save();
  doc.rect(tableX, y, totalW, 2).fill(THEME.accent);
  doc.restore();

  // Header background
  doc.save();
  doc.rect(tableX, y + 2, totalW, rowH - 2).fill(THEME.headerBg);
  doc.restore();

  // Header text
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(THEME.headerText);
  let cx = tableX;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 6, y + (rowH - 7.5) / 2 + 1, {
      width: colWidths[i] - 12,
      align: 'center',
    });
    cx += colWidths[i];
  }

  return y + rowH;
}

function pdfDrawInfoCards(
  doc: PDFKit.PDFDocument,
  marginLeft: number,
  contentWidth: number,
  startY: number,
): number {
  const gap = 14;
  const cardW = (contentWidth - gap) / 2;
  const cardH = 78;
  const r = 8;
  const circleR = 14;

  for (let i = 0; i < INFO_CARDS.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = marginLeft + col * (cardW + gap);
    const cy = startY + row * (cardH + gap);

    // Card background
    doc.save();
    doc.roundedRect(cx, cy, cardW, cardH, r).fill(THEME.cardBg);
    doc.roundedRect(cx, cy, cardW, cardH, r)
      .strokeColor(THEME.cardBorder).lineWidth(0.5).stroke();
    doc.restore();

    // Teal circle (decorative icon)
    const circleX = cx + 22;
    const circleY = cy + cardH / 2;
    doc.save();
    doc.circle(circleX, circleY, circleR).fill(THEME.accent);
    doc.restore();

    // Title
    const textX = circleX + circleR + 14;
    const textW = cardW - (textX - cx) - 14;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(THEME.text);
    doc.text(INFO_CARDS[i].title, textX, cy + 16, { width: textW, lineBreak: false });

    // Body text
    doc.font('Helvetica').fontSize(7).fillColor(THEME.textLight);
    doc.text(INFO_CARDS[i].body, textX, cy + 30, { width: textW, lineGap: 1.5 });
  }

  return startY + 2 * cardH + gap;
}

function pdfDrawFooter(
  doc: PDFKit.PDFDocument,
  marginLeft: number,
  contentWidth: number,
  pageNum: number,
  totalPages: number,
): void {
  const footerY = doc.page.height - doc.page.margins.bottom - 28;

  // Separator line
  doc.save();
  doc.moveTo(marginLeft, footerY)
    .lineTo(marginLeft + contentWidth, footerY)
    .strokeColor(THEME.border).lineWidth(0.5).stroke();
  doc.restore();

  // Legal line 1 (bold company name)
  doc.fontSize(6).font('Helvetica-Bold').fillColor(THEME.text);
  doc.text(COMPANY.legalLine1, marginLeft, footerY + 6, { lineBreak: false });

  // Legal line 2 (website + TVA in teal)
  doc.fontSize(6).font('Helvetica').fillColor(THEME.accent);
  doc.text(COMPANY.legalLine2, marginLeft, footerY + 16, { lineBreak: false });

  // Page number
  doc.fontSize(6).font('Helvetica').fillColor(THEME.muted);
  doc.text(`Page ${pageNum}/${totalPages}`, marginLeft, footerY + 11, {
    width: contentWidth,
    align: 'right',
  });
}

/**
 * Generate a PDF buffer matching the USI-PRO "Demande de Devis" template.
 */
export async function generatePdf(ofNumber: string, parts: Part[]): Promise<Buffer> {
  const log = ofLogger(ofNumber);
  log.info({ partCount: parts.length }, 'Generating PDF locally');

  const date = formatDateFR();

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      const result = Buffer.concat(chunks);
      log.info({ sizeBytes: result.length }, 'PDF generated');
      resolve(result);
    });
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const marginLeft = doc.page.margins.left;
    const contentWidth = pageWidth - marginLeft - doc.page.margins.right;

    // ─── Header ──────────────────────────────────────────────
    const headerEnd = pdfDrawHeader(doc, pageWidth, marginLeft, contentWidth);

    // ─── Title + Réf / Date pills ────────────────────────────
    let y = headerEnd + 22;

    doc.fontSize(22).font('Helvetica-Bold').fillColor(THEME.text);
    doc.text('Quote Request', marginLeft, y, { lineBreak: false });

    // Date pill (rightmost)
    const pillH = 24;
    const dateStr = `Date: ${date}`;
    doc.font('Helvetica').fontSize(9);
    const dateW = doc.widthOfString(dateStr) + 24;
    const datePillX = marginLeft + contentWidth - dateW;

    // Ref pill (left of date pill)
    const refStr = `Ref: ${ofNumber}`;
    const refW = doc.widthOfString(refStr) + 24;
    const refPillX = datePillX - refW - 8;

    const pillY = y + 3;
    pdfDrawPill(doc, refStr, refPillX, pillY, pillH);
    pdfDrawPill(doc, dateStr, datePillX, pillY, pillH);

    y += 46;

    // ─── PARTS DETAILS ───────────────────────────────────────
    pdfDrawSectionLabel(doc, 'P A R T S   D E T A I L S', marginLeft, y);
    y += 14;

    const headers = ['REFERENCE', 'QUANTITY', 'MATERIAL', 'TREATMENT', 'COMMENTS'];
    const colWidths = [
      Math.round(contentWidth * 0.20),
      Math.round(contentWidth * 0.16),
      Math.round(contentWidth * 0.18),
      Math.round(contentWidth * 0.20),
      0,
    ];
    colWidths[4] = contentWidth - colWidths[0] - colWidths[1] - colWidths[2] - colWidths[3];

    const rowH = 34;
    const tableX = marginLeft;

    // Table header
    y = pdfDrawTableHeader(doc, headers, colWidths, tableX, y, rowH);

    // Data rows
    for (let r = 0; r < parts.length; r++) {
      const part = parts[r];
      const bgColor = r % 2 === 0 ? '#ffffff' : THEME.altRow;

      // Page break check
      if (y + rowH > doc.page.height - doc.page.margins.bottom - 140) {
        doc.addPage();
        y = doc.page.margins.top;
        y = pdfDrawTableHeader(doc, headers, colWidths, tableX, y, rowH);
      }

      // Row background
      const totalW = colWidths.reduce((a, b) => a + b, 0);
      doc.save();
      doc.rect(tableX, y, totalW, rowH).fill(bgColor);
      doc.restore();

      // Cell borders
      let bx = tableX;
      for (let c = 0; c < colWidths.length; c++) {
        doc.rect(bx, y, colWidths[c], rowH)
          .strokeColor(THEME.border).lineWidth(0.3).stroke();
        bx += colWidths[c];
      }

      // Cell values
      const values = [part.id, part.quantity, part.material, part.processing, part.comment];
      let cx = tableX;
      for (let c = 0; c < values.length; c++) {
        const cellY = y + (rowH - 9) / 2;

        if (c === 1 && values[c]) {
          // Quantity: teal pill "× N"
          const qText = `\u00d7 ${values[c]}`;
          doc.font('Helvetica-Bold').fontSize(8);
          const qw = doc.widthOfString(qText);
          const pw = qw + 14;
          const px = cx + (colWidths[c] - pw) / 2;
          doc.save();
          doc.roundedRect(px, cellY - 3, pw, 16, 8).fill(THEME.pillTealBg);
          doc.restore();
          doc.fillColor(THEME.accent).text(qText, px + 7, cellY, { lineBreak: false });
        } else if (c === 2 && values[c]) {
          // Material: gray pill
          doc.font('Helvetica').fontSize(8);
          const mw = doc.widthOfString(values[c]);
          const pw = mw + 14;
          const px = cx + (colWidths[c] - pw) / 2;
          doc.save();
          doc.roundedRect(px, cellY - 3, pw, 16, 8).fill(THEME.pillGrayBg);
          doc.restore();
          doc.fillColor(THEME.text).text(values[c], px + 7, cellY, { lineBreak: false });
        } else {
          // Regular text
          doc.font('Helvetica').fontSize(8).fillColor(THEME.text);
          doc.text(values[c] || '\u2014', cx + 6, cellY, {
            width: colWidths[c] - 12,
            align: c === 0 ? 'left' : 'center',
          });
        }
        cx += colWidths[c];
      }

      y += rowH;
    }

    y += 24;

    // ─── INFORMATIONS ────────────────────────────────────────
    // Check if info section fits on current page
    if (y + 200 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }

    pdfDrawSectionLabel(doc, 'I N F O R M A T I O N', marginLeft, y);
    y += 18;

    pdfDrawInfoCards(doc, marginLeft, contentWidth, y);

    // ─── Footer on every page ────────────────────────────────
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      pdfDrawFooter(doc, marginLeft, contentWidth, i + 1, totalPages);
    }

    doc.end();
  });
}

// ─── DOCX Generation ────────────────────────────────────────────────────────

const DOCX_BORDER = {
  style: BorderStyle.SINGLE,
  size: 1,
  color: 'E0E0E0',
};

const DOCX_TABLE_BORDERS = {
  top: DOCX_BORDER,
  bottom: DOCX_BORDER,
  left: DOCX_BORDER,
  right: DOCX_BORDER,
  insideHorizontal: DOCX_BORDER,
  insideVertical: DOCX_BORDER,
};

const DOCX_NO_BORDER = {
  style: BorderStyle.NONE,
  size: 0,
  color: '1E2D3D',
};

/**
 * Generate a DOCX buffer matching the USI-PRO "Demande de Devis" template.
 */
export async function generateDocx(ofNumber: string, parts: Part[]): Promise<Buffer> {
  const log = ofLogger(ofNumber);
  log.info({ partCount: parts.length }, 'Generating DOCX locally');

  const date = formatDateFR();

  // ─── Header banner (simulated with full-width table) ──────
  const logoBuffer = loadLogo();
  const headerCells: TableCell[] = [];

  // Logo cell
  if (logoBuffer) {
    headerCells.push(
      new TableCell({
        children: [
          new Paragraph({
            children: [
              new ImageRun({
                data: logoBuffer,
                transformation: { width: 140, height: 55 },
                type: 'png',
              }),
            ],
            alignment: AlignmentType.LEFT,
          }),
        ],
        shading: { fill: '1E2D3D', color: 'auto', type: ShadingType.CLEAR },
        verticalAlign: VerticalAlign.CENTER,
        width: { size: 40, type: WidthType.PERCENTAGE },
        borders: {
          top: DOCX_NO_BORDER,
          bottom: DOCX_NO_BORDER,
          left: DOCX_NO_BORDER,
          right: DOCX_NO_BORDER,
        },
      }),
    );
  } else {
    headerCells.push(
      new TableCell({
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: COMPANY.name,
                bold: true,
                font: 'Arial',
                size: 40,
                color: 'FFFFFF',
              }),
            ],
          }),
        ],
        shading: { fill: '1E2D3D', color: 'auto', type: ShadingType.CLEAR },
        verticalAlign: VerticalAlign.CENTER,
        width: { size: 40, type: WidthType.PERCENTAGE },
        borders: {
          top: DOCX_NO_BORDER,
          bottom: DOCX_NO_BORDER,
          left: DOCX_NO_BORDER,
          right: DOCX_NO_BORDER,
        },
      }),
    );
  }

  // Company info cell (right side)
  headerCells.push(
    new TableCell({
      children: [
        new Paragraph({
          children: [
            new TextRun({ text: COMPANY.address, font: 'Arial', size: 16, color: 'FFFFFF' }),
          ],
          alignment: AlignmentType.RIGHT,
          spacing: { after: 20 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: COMPANY.email, font: 'Arial', size: 16, color: 'FFFFFF' }),
          ],
          alignment: AlignmentType.RIGHT,
          spacing: { after: 20 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: COMPANY.phone, font: 'Arial', size: 16, color: 'FFFFFF' }),
          ],
          alignment: AlignmentType.RIGHT,
          spacing: { after: 20 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: COMPANY.website, font: 'Arial', size: 16, color: 'FFFFFF' }),
          ],
          alignment: AlignmentType.RIGHT,
        }),
      ],
      shading: { fill: '1E2D3D', color: 'auto', type: ShadingType.CLEAR },
      verticalAlign: VerticalAlign.CENTER,
      width: { size: 60, type: WidthType.PERCENTAGE },
      borders: {
        top: DOCX_NO_BORDER,
        bottom: DOCX_NO_BORDER,
        left: DOCX_NO_BORDER,
        right: DOCX_NO_BORDER,
      },
    }),
  );

  const headerBanner = new Table({
    rows: [
      new TableRow({
        children: headerCells,
        height: { value: 1200, rule: 'atLeast' as any },
      }),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: DOCX_NO_BORDER,
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '3ECDC6' },
      left: DOCX_NO_BORDER,
      right: DOCX_NO_BORDER,
      insideHorizontal: DOCX_NO_BORDER,
      insideVertical: DOCX_NO_BORDER,
    },
  });

  // ─── Parts table header row ────────────────────────────────
  const tableHeaders = ['Reference', 'Quantity', 'Material', 'Treatment', 'Comments'];
  const partTableHeaderRow = new TableRow({
    tableHeader: true,
    children: tableHeaders.map(
      (text) =>
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text, bold: true, font: 'Arial', size: 18, color: 'FFFFFF' })],
              alignment: AlignmentType.CENTER,
            }),
          ],
          shading: { fill: '1E2D3D', color: 'auto', type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
        }),
    ),
  });

  // ─── Parts table data rows ─────────────────────────────────
  const dataRows = parts.map((part, i) => {
    const values = [part.id, `\u00d7 ${part.quantity}`, part.material, part.processing, part.comment];
    return new TableRow({
      children: values.map(
        (text, colIdx) =>
          new TableCell({
            children: [
              new Paragraph({
                children: [new TextRun({ text: text || '\u2014', font: 'Arial', size: 18 })],
                alignment: colIdx <= 2 ? AlignmentType.CENTER : AlignmentType.LEFT,
              }),
            ],
            shading: i % 2 === 1 ? { fill: 'F8FAFC', color: 'auto', type: ShadingType.CLEAR } : undefined,
            verticalAlign: VerticalAlign.CENTER,
          }),
      ),
    });
  });

  // ─── Info cards (as a 2×2 table) ───────────────────────────
  const infoNoBorder = {
    top: { style: BorderStyle.SINGLE, size: 1, color: 'E8EAED' },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E8EAED' },
    left: { style: BorderStyle.SINGLE, size: 1, color: 'E8EAED' },
    right: { style: BorderStyle.SINGLE, size: 1, color: 'E8EAED' },
  };

  const infoRows = [];
  for (let row = 0; row < 2; row++) {
    const cells = [];
    for (let col = 0; col < 2; col++) {
      const card = INFO_CARDS[row * 2 + col];
      cells.push(
        new TableCell({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: card.title,
                  bold: true,
                  font: 'Arial',
                  size: 16,
                  color: '1E2D3D',
                }),
              ],
              spacing: { after: 60 },
            }),
            new Paragraph({
              children: [
                new TextRun({
                  text: card.body,
                  font: 'Arial',
                  size: 15,
                  color: '4A5568',
                }),
              ],
            }),
          ],
          shading: { fill: 'F7F8FA', color: 'auto', type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          borders: infoNoBorder,
          margins: { top: 120, bottom: 120, left: 120, right: 120 },
        }),
      );
    }
    infoRows.push(new TableRow({ children: cells }));
  }

  const infoTable = new Table({
    rows: infoRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
  });

  // ─── Assemble document ─────────────────────────────────────
  const doc = new Document({
    sections: [
      {
        children: [
          // Header banner
          headerBanner,
          new Paragraph({ spacing: { after: 200 }, children: [] }),
          // Title + Réf / Date
          new Paragraph({
            children: [
              new TextRun({
                text: 'Quote Request',
                bold: true,
                font: 'Arial',
                size: 36,
                color: '1E2D3D',
              }),
              new TextRun({
                text: `\tRef: ${ofNumber}     Date: ${date}`,
                font: 'Arial',
                size: 18,
                color: '1E2D3D',
              }),
            ],
            spacing: { after: 300 },
            tabStops: [{ type: 'right' as any, position: 9000 }],
          }),
          // Section label
          new Paragraph({
            children: [
              new TextRun({
                text: 'P A R T S   D E T A I L S',
                bold: true,
                font: 'Arial',
                size: 16,
                color: '3ECDC6',
              }),
            ],
            spacing: { after: 100 },
          }),
          // Parts table
          new Table({
            rows: [partTableHeaderRow, ...dataRows],
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            borders: DOCX_TABLE_BORDERS,
          }),
          new Paragraph({ spacing: { after: 300 }, children: [] }),
          // Information label
          new Paragraph({
            children: [
              new TextRun({
                text: 'I N F O R M A T I O N',
                bold: true,
                font: 'Arial',
                size: 16,
                color: '3ECDC6',
              }),
            ],
            spacing: { after: 100 },
          }),
          // Info cards table
          infoTable,
          new Paragraph({ spacing: { after: 200 }, children: [] }),
          // Footer line 1
          new Paragraph({
            children: [
              new TextRun({
                text: COMPANY.legalLine1,
                font: 'Arial',
                size: 12,
                color: '1E2D3D',
                bold: true,
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 20 },
          }),
          // Footer line 2
          new Paragraph({
            children: [
              new TextRun({
                text: COMPANY.legalLine2,
                font: 'Arial',
                size: 12,
                color: '3ECDC6',
              }),
            ],
            alignment: AlignmentType.CENTER,
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  log.info({ sizeBytes: buffer.length }, 'DOCX generated');
  return buffer;
}
