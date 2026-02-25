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
  tagline: 'Usinage de précision',
  address: '13 Rte de Citon Cénac, 33670 SADIRAC',
  email: 'accueil@usi-pro.com',
  phone: '05 47 74 15 12',
  website: 'www.usi-pro.com',
  legal: 'USI-PRO | SARL au capital de 15 000 € | SIRET : 920 812 401 00015',
  tva: 'TVA : FR17920812401',
};

// ─── Info cards content ──────────────────────────────────────────────────────

const INFO_CARDS = [
  {
    title: 'Delivery Time',
    body: 'Maximum 18 days after order placement, unless otherwise stated in the comments.',
  },
  {
    title: 'Questions',
    body: 'Contact us at accueil@usi-pro.com',
  },
  {
    title: 'Payment & Currency',
    body: 'Per our usual terms. Accepted currencies: € or $',
  },
  {
    title: 'Shipping',
    body: 'Shipping can be arranged at your expense and re-invoiced. Please provide an estimated quote in advance.',
  },
];

// ─── Theme (USI-PRO brand colors — navy/green scheme) ───────────────────────

const THEME = {
  primary: '#0f1a2e',
  accent: '#1abc9c',
  deepAccent: '#148f77',
  headerBg: '#0f1a2e',
  headerText: '#ffffff',
  surfaceAlt: '#f0f4f8',
  altRow: '#f0f4f8',
  text: '#1e293b',
  muted: '#475569',
  border: '#cbd5e1',
};

// ─── PDF Generation (pdfkit) ────────────────────────────────────────────────

/**
 * Draw the table header row and return the new Y position.
 */
function drawTableHeader(
  doc: PDFKit.PDFDocument,
  headers: string[],
  colWidths: number[],
  tableLeft: number,
  y: number,
  rowHeight: number,
): number {
  let x = tableLeft;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(THEME.headerText);
  for (let c = 0; c < headers.length; c++) {
    doc.rect(x, y, colWidths[c], rowHeight).fill(THEME.headerBg);
    doc.fillColor(THEME.headerText)
      .text(headers[c], x + 4, y + 8, { width: colWidths[c] - 8, align: 'center' });
    x += colWidths[c];
  }
  return y + rowHeight;
}

/**
 * Generate a PDF buffer matching the USI-PRO "Demande de Devis" template.
 */
export async function generatePdf(ofNumber: string, parts: Part[]): Promise<Buffer> {
  const log = ofLogger(ofNumber);
  log.info({ partCount: parts.length }, 'Generating PDF locally');

  const date = formatDateFR();

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
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

    // ─── Full-width Header Banner ──────────────────────────────
    const headerHeight = 85;

    // Dark navy banner (full bleed)
    doc.save();
    doc.rect(0, 0, pageWidth, headerHeight).fill(THEME.primary);

    // Teal accent line below header (solid for PDF)
    doc.rect(0, headerHeight, pageWidth, 3).fill(THEME.accent);
    doc.restore();

    // Logo in header (left side)
    const logoBuffer = loadLogo();
    if (logoBuffer) {
      const logoH = 48;
      const logoY = (headerHeight - logoH) / 2;
      doc.image(logoBuffer, marginLeft, logoY, { height: logoH });
    } else {
      doc.fontSize(24).font('Helvetica-Bold').fillColor('#ffffff')
        .text(COMPANY.name, marginLeft, 30);
    }

    // Contact info block (right side of header) — small white text
    const contactLines = [
      COMPANY.address,
      COMPANY.email,
      COMPANY.phone,
      COMPANY.website,
    ];
    const contactBlockWidth = 200;
    const contactX = pageWidth - doc.page.margins.right - contactBlockWidth;
    doc.fontSize(7).font('Helvetica').fillColor('rgba(255,255,255,0.85)');
    let contactY = 14;
    for (const line of contactLines) {
      doc.fillColor('rgba(255,255,255,0.85)')
        .text(line, contactX, contactY, { width: contactBlockWidth, align: 'right' });
      contactY += 16;
    }

    doc.y = headerHeight + 16;

    // ─── Title Bar ─────────────────────────────────────────────
    const titleBarY = doc.y;

    // "Quote Request" — large bold left
    doc.fontSize(18).font('Helvetica-Bold').fillColor(THEME.primary)
      .text('Quote Request', marginLeft, titleBarY);

    // Ref chip and Date chip — right side
    const chipY = titleBarY + 2;
    const refText = `Ref: ${ofNumber}`;
    const dateText = `Date: ${date}`;
    const chipFontSize = 9;
    doc.fontSize(chipFontSize).font('Helvetica');

    const refTextWidth = doc.widthOfString(refText) + 14;
    const dateTextWidth = doc.widthOfString(dateText) + 14;
    const chipGap = 8;
    const chipHeight = 18;
    const chipRadius = 4;

    const dateChipX = marginLeft + contentWidth - dateTextWidth;
    const refChipX = dateChipX - chipGap - refTextWidth;

    // Draw ref chip
    doc.save();
    doc.roundedRect(refChipX, chipY, refTextWidth, chipHeight, chipRadius)
      .fill(THEME.surfaceAlt);
    doc.roundedRect(refChipX, chipY, refTextWidth, chipHeight, chipRadius)
      .strokeColor(THEME.border).lineWidth(0.5).stroke();
    doc.fillColor(THEME.text)
      .text(refText, refChipX + 7, chipY + 5, { width: refTextWidth - 14, align: 'center' });
    doc.restore();

    // Draw date chip
    doc.save();
    doc.roundedRect(dateChipX, chipY, dateTextWidth, chipHeight, chipRadius)
      .fill(THEME.surfaceAlt);
    doc.roundedRect(dateChipX, chipY, dateTextWidth, chipHeight, chipRadius)
      .strokeColor(THEME.border).lineWidth(0.5).stroke();
    doc.fillColor(THEME.text)
      .text(dateText, dateChipX + 7, chipY + 5, { width: dateTextWidth - 14, align: 'center' });
    doc.restore();

    doc.y = titleBarY + 28;
    doc.moveDown(0.5);

    // Thin separator line
    doc.moveTo(marginLeft, doc.y)
      .lineTo(marginLeft + contentWidth, doc.y)
      .strokeColor(THEME.border).lineWidth(0.5).stroke();
    doc.moveDown(0.8);

    // ─── Parts Table (5 columns, no # index) ───────────────────
    const headers = ['Reference', 'Quantity', 'Material', 'Treatment', 'Comments'];
    const colWidths = [90, 60, 100, 110, contentWidth - 90 - 60 - 100 - 110];
    const tableLeft = marginLeft;
    const rowHeight = 24;

    // Header row
    let y = drawTableHeader(doc, headers, colWidths, tableLeft, doc.y, rowHeight);

    // Data rows
    doc.font('Helvetica').fontSize(9).fillColor(THEME.text);
    for (let r = 0; r < parts.length; r++) {
      const part = parts[r];
      // Quantity displayed as "× N"
      const qtyDisplay = part.quantity ? `\u00d7 ${part.quantity}` : '—';
      const values = [part.id, qtyDisplay, part.material, part.processing, part.comment];
      const bgColor = r % 2 === 0 ? '#ffffff' : THEME.altRow;

      // Page break check — repeat header on new page
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 80) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawTableHeader(doc, headers, colWidths, tableLeft, y, rowHeight);
        doc.font('Helvetica').fontSize(9).fillColor(THEME.text);
      }

      let x = tableLeft;
      for (let c = 0; c < values.length; c++) {
        doc.rect(x, y, colWidths[c], rowHeight).fill(bgColor);
        doc.fillColor(THEME.text)
          .text(values[c] || '—', x + 4, y + 8, {
            width: colWidths[c] - 8,
            align: c <= 1 ? 'center' : 'left',
          });
        x += colWidths[c];
      }

      // Thin cell borders
      x = tableLeft;
      for (let c = 0; c < colWidths.length; c++) {
        doc.rect(x, y, colWidths[c], rowHeight)
          .strokeColor(THEME.border).lineWidth(0.3).stroke();
        x += colWidths[c];
      }

      y += rowHeight;
    }

    doc.y = y;
    doc.moveDown(1.5);

    // ─── Info Cards Section ────────────────────────────────────
    if (doc.y + 120 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }

    // Section label "INFORMATION"
    doc.fontSize(9).font('Helvetica-Bold').fillColor(THEME.primary)
      .text('INFORMATION', marginLeft, doc.y);
    doc.moveDown(0.5);

    const cardGap = 10;
    const cardWidth = (contentWidth - cardGap) / 2;
    const cardPadding = 10;
    const cardRadius = 4;

    // Draw 2 cards per row (2 rows = 4 cards total)
    for (let row = 0; row < 2; row++) {
      const cardsInRow = [INFO_CARDS[row * 2], INFO_CARDS[row * 2 + 1]];

      // Measure card heights to pick the taller one for the row
      const tempFontSize = 7.5;
      doc.fontSize(tempFontSize).font('Helvetica');
      const innerWidth = cardWidth - cardPadding * 2;

      // Estimate heights
      const rowHeights = cardsInRow.map((card) => {
        const titleH = 11; // ~bold 9pt title
        const bodyLines = Math.ceil(doc.widthOfString(card.body) / innerWidth) + 1;
        const bodyH = bodyLines * (tempFontSize + 2);
        return titleH + 4 + bodyH + cardPadding * 2;
      });
      const cardH = Math.max(...rowHeights, 60);

      // Page break check
      if (doc.y + cardH + 10 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }

      const rowY = doc.y;

      for (let col = 0; col < 2; col++) {
        const card = cardsInRow[col];
        if (!card) continue;
        const cardX = marginLeft + col * (cardWidth + cardGap);

        // Card background and border
        doc.save();
        doc.roundedRect(cardX, rowY, cardWidth, cardH, cardRadius)
          .fill(THEME.surfaceAlt);
        doc.roundedRect(cardX, rowY, cardWidth, cardH, cardRadius)
          .strokeColor(THEME.border).lineWidth(0.5).stroke();

        // Card title (bold, small, accent-ish dark)
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor(THEME.primary)
          .text(card.title.toUpperCase(), cardX + cardPadding, rowY + cardPadding, {
            width: innerWidth,
          });

        const titleBottomY = rowY + cardPadding + 11 + 4;

        // Card body text
        doc.fontSize(8.5).font('Helvetica').fillColor(THEME.text)
          .text(card.body, cardX + cardPadding, titleBottomY, {
            width: innerWidth,
          });

        doc.restore();
      }

      doc.y = rowY + cardH + cardGap;
    }

    // ─── Footer ────────────────────────────────────────────────
    const footerY = doc.page.height - doc.page.margins.bottom - 20;

    doc.moveTo(marginLeft, footerY - 8)
      .lineTo(marginLeft + contentWidth, footerY - 8)
      .strokeColor(THEME.border).lineWidth(0.5).stroke();

    // Legal info left
    doc.fontSize(7.5).font('Helvetica').fillColor(THEME.muted)
      .text(`${COMPANY.legal} | ${COMPANY.website} | ${COMPANY.tva}`, marginLeft, footerY, {
        width: contentWidth - 60,
        align: 'left',
      });

    // Page 1/1 right
    doc.fontSize(7.5).font('Helvetica').fillColor(THEME.muted)
      .text('Page 1/1', marginLeft, footerY, {
        width: contentWidth,
        align: 'right',
      });

    doc.end();
  });
}

// ─── DOCX Generation ────────────────────────────────────────────────────────

const DOCX_BORDER = {
  style: BorderStyle.SINGLE,
  size: 1,
  color: 'E2E8F0',
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
  color: '0F1A2E',
};

/**
 * Generate a DOCX buffer matching the USI-PRO "Demande de Devis" template.
 */
export async function generateDocx(ofNumber: string, parts: Part[]): Promise<Buffer> {
  const log = ofLogger(ofNumber);
  log.info({ partCount: parts.length }, 'Generating DOCX locally');

  const date = formatDateFR();

  // ─── Header banner (logo left, contact info right) ───────────
  const logoBuffer = loadLogo();
  const headerCells: TableCell[] = [];

  // Logo cell (left)
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
        shading: { fill: '0F1A2E', color: 'auto', type: ShadingType.CLEAR },
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
        shading: { fill: '0F1A2E', color: 'auto', type: ShadingType.CLEAR },
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

  // Contact info cell (right) — 4 lines of small white text
  const contactLines = [
    COMPANY.address,
    COMPANY.email,
    COMPANY.phone,
    COMPANY.website,
  ];
  headerCells.push(
    new TableCell({
      children: contactLines.map(
        (line) =>
          new Paragraph({
            children: [
              new TextRun({
                text: line,
                font: 'Arial',
                size: 16,
                color: 'FFFFFF',
              }),
            ],
            alignment: AlignmentType.RIGHT,
            spacing: { after: 20 },
          }),
      ),
      shading: { fill: '0F1A2E', color: 'auto', type: ShadingType.CLEAR },
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
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '1ABC9C' },
      left: DOCX_NO_BORDER,
      right: DOCX_NO_BORDER,
      insideHorizontal: DOCX_NO_BORDER,
      insideVertical: DOCX_NO_BORDER,
    },
  });

  // ─── Title row: "Demande de Devis" left, ref + date right ────
  const titleRow = new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: 'Quote Request',
                    bold: true,
                    font: 'Arial',
                    size: 36,
                    color: '0F1A2E',
                  }),
                ],
                alignment: AlignmentType.LEFT,
              }),
            ],
            verticalAlign: VerticalAlign.CENTER,
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: {
              top: DOCX_NO_BORDER,
              bottom: DOCX_NO_BORDER,
              left: DOCX_NO_BORDER,
              right: DOCX_NO_BORDER,
            },
          }),
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: `Ref: ${ofNumber}`,
                    font: 'Arial',
                    size: 18,
                    color: '0F1A2E',
                  }),
                  new TextRun({
                    text: `   Date: ${date}`,
                    font: 'Arial',
                    size: 18,
                    color: '0F1A2E',
                  }),
                ],
                alignment: AlignmentType.RIGHT,
              }),
            ],
            verticalAlign: VerticalAlign.CENTER,
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: {
              top: DOCX_NO_BORDER,
              bottom: DOCX_NO_BORDER,
              left: DOCX_NO_BORDER,
              right: DOCX_NO_BORDER,
            },
          }),
        ],
      }),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: DOCX_NO_BORDER,
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      left: DOCX_NO_BORDER,
      right: DOCX_NO_BORDER,
      insideHorizontal: DOCX_NO_BORDER,
      insideVertical: DOCX_NO_BORDER,
    },
  });

  // ─── Parts table (5 columns, no #) ───────────────────────────
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
          shading: { fill: '0F1A2E', color: 'auto', type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
        }),
    ),
  });

  const dataRows = parts.map((part, i) => {
    // Quantity displayed as "× N"
    const qtyDisplay = part.quantity ? `\u00d7 ${part.quantity}` : '—';
    const values = [part.id, qtyDisplay, part.material, part.processing, part.comment];
    return new TableRow({
      children: values.map(
        (text, colIdx) =>
          new TableCell({
            children: [
              new Paragraph({
                children: [new TextRun({ text: text || '—', font: 'Arial', size: 18 })],
                alignment: colIdx <= 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
              }),
            ],
            shading: i % 2 === 1 ? { fill: 'F0F4F8', color: 'auto', type: ShadingType.CLEAR } : undefined,
            verticalAlign: VerticalAlign.CENTER,
          }),
      ),
    });
  });

  // ─── Info cards section ───────────────────────────────────────
  const infoSectionLabel = new Paragraph({
    children: [
      new TextRun({
        text: 'INFORMATION',
        bold: true,
        font: 'Arial',
        size: 18,
        color: '0F1A2E',
      }),
    ],
    spacing: { before: 300, after: 100 },
  });

  // 2×2 grid as a table (each cell = one info card)
  const infoCardsTable = new Table({
    rows: [
      // Row 1: cards 0 and 1
      new TableRow({
        children: [0, 1].map((idx) => {
          const card = INFO_CARDS[idx];
          return new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: card.title.toUpperCase(),
                    bold: true,
                    font: 'Arial',
                    size: 17,
                    color: '0F1A2E',
                  }),
                ],
                spacing: { after: 60 },
              }),
              new Paragraph({
                children: [
                  new TextRun({
                    text: card.body,
                    font: 'Arial',
                    size: 17,
                    color: '374151',
                  }),
                ],
              }),
            ],
            shading: { fill: 'F0F4F8', color: 'auto', type: ShadingType.CLEAR },
            verticalAlign: VerticalAlign.TOP,
            width: { size: 50, type: WidthType.PERCENTAGE },
            margins: {
              top: 100,
              bottom: 100,
              left: 120,
              right: 120,
            },
            borders: DOCX_TABLE_BORDERS,
          });
        }),
      }),
      // Row 2: cards 2 and 3
      new TableRow({
        children: [2, 3].map((idx) => {
          const card = INFO_CARDS[idx];
          return new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: card.title.toUpperCase(),
                    bold: true,
                    font: 'Arial',
                    size: 17,
                    color: '0F1A2E',
                  }),
                ],
                spacing: { after: 60 },
              }),
              new Paragraph({
                children: [
                  new TextRun({
                    text: card.body,
                    font: 'Arial',
                    size: 17,
                    color: '374151',
                  }),
                ],
              }),
            ],
            shading: { fill: 'F0F4F8', color: 'auto', type: ShadingType.CLEAR },
            verticalAlign: VerticalAlign.TOP,
            width: { size: 50, type: WidthType.PERCENTAGE },
            margins: {
              top: 100,
              bottom: 100,
              left: 120,
              right: 120,
            },
            borders: DOCX_TABLE_BORDERS,
          });
        }),
      }),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: DOCX_TABLE_BORDERS,
  });

  // ─── Footer ───────────────────────────────────────────────────
  const footerTable = new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: `${COMPANY.legal} | ${COMPANY.website} | ${COMPANY.tva}`,
                    font: 'Arial',
                    size: 15,
                    color: '475569',
                  }),
                ],
                alignment: AlignmentType.LEFT,
              }),
            ],
            verticalAlign: VerticalAlign.CENTER,
            width: { size: 80, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
              bottom: DOCX_NO_BORDER,
              left: DOCX_NO_BORDER,
              right: DOCX_NO_BORDER,
            },
          }),
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: 'Page 1/1',
                    font: 'Arial',
                    size: 15,
                    color: '475569',
                  }),
                ],
                alignment: AlignmentType.RIGHT,
              }),
            ],
            verticalAlign: VerticalAlign.CENTER,
            width: { size: 20, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
              bottom: DOCX_NO_BORDER,
              left: DOCX_NO_BORDER,
              right: DOCX_NO_BORDER,
            },
          }),
        ],
      }),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: DOCX_NO_BORDER,
      bottom: DOCX_NO_BORDER,
      left: DOCX_NO_BORDER,
      right: DOCX_NO_BORDER,
      insideHorizontal: DOCX_NO_BORDER,
      insideVertical: DOCX_NO_BORDER,
    },
  });

  // ─── Assemble document ────────────────────────────────────────
  const doc = new Document({
    sections: [
      {
        children: [
          // Header banner
          headerBanner,
          // Spacer
          new Paragraph({ spacing: { after: 160 }, children: [] }),
          // Title row
          titleRow,
          // Spacer
          new Paragraph({ spacing: { after: 200 }, children: [] }),
          // Parts table
          new Table({
            rows: [partTableHeaderRow, ...dataRows],
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            borders: DOCX_TABLE_BORDERS,
          }),
          // Spacer
          new Paragraph({ spacing: { after: 200 }, children: [] }),
          // Info cards section label
          infoSectionLabel,
          // Info cards 2x2 table
          infoCardsTable,
          // Spacer
          new Paragraph({ spacing: { after: 300 }, children: [] }),
          // Footer table
          footerTable,
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  log.info({ sizeBytes: buffer.length }, 'DOCX generated');
  return buffer;
}
