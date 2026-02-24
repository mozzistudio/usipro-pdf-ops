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
  legal: 'SARL au capital de 15 000 € | SIRET : 920 812 401 00015 | TVA : FR17920812401',
};

const TERMS = [
  'Délai souhaité : 18 jours maximum après passation de commande, sauf indication contraire dans les commentaires des pièces.',
  'Pour toute question : Accueil@usi-pro.com',
  'Le paiement suit l\'accord standard entre les parties.',
  'Devises acceptées : € ou $',
  'Le transport peut être pris en charge par le destinataire avec remboursement des frais ; des estimations préalables sont demandées.',
];

// ─── Theme (USI-PRO brand colors) ───────────────────────────────────────────

const THEME = {
  primary: '#240C2E',
  accent: '#99eeeb',
  headerBg: '#240C2E',
  headerText: '#ffffff',
  altRow: '#f5f3f7',
  text: '#2c2c2c',
  muted: '#666666',
  border: '#e0e0e0',
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
  doc.fontSize(8).font('Helvetica-Bold').fillColor(THEME.headerText);
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

    // Dark purple banner (full bleed)
    doc.save();
    doc.rect(0, 0, pageWidth, headerHeight).fill(THEME.primary);

    // Teal accent line below header
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

    // "DEMANDE DE DEVIS" title (right side of header)
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#ffffff')
      .text('DEMANDE DE DEVIS', marginLeft, 30, {
        width: contentWidth,
        align: 'right',
      });

    doc.y = headerHeight + 22;

    // ─── Reference & Date ──────────────────────────────────────
    const refDateY = doc.y;

    doc.fontSize(11).font('Helvetica-Bold').fillColor(THEME.primary)
      .text(`Référence : OF${ofNumber}`, marginLeft, refDateY);

    doc.fontSize(11).font('Helvetica').fillColor(THEME.text)
      .text(`Date : ${date}`, marginLeft, refDateY, {
        width: contentWidth,
        align: 'right',
      });

    doc.y = refDateY + 20;
    doc.moveDown(0.6);

    // Thin separator
    doc.moveTo(marginLeft, doc.y)
      .lineTo(marginLeft + contentWidth, doc.y)
      .strokeColor(THEME.border).lineWidth(0.5).stroke();
    doc.moveDown(0.8);

    // ─── Parts Table ───────────────────────────────────────────
    const headers = ['#', 'Référence', 'Quantité', 'Matériau', 'Traitement', 'Commentaires'];
    const colWidths = [30, 80, 60, 100, 105, contentWidth - 30 - 80 - 60 - 100 - 105];
    const tableLeft = marginLeft;
    const rowHeight = 24;

    // Header row
    let y = drawTableHeader(doc, headers, colWidths, tableLeft, doc.y, rowHeight);

    // Data rows
    doc.font('Helvetica').fontSize(8).fillColor(THEME.text);
    for (let r = 0; r < parts.length; r++) {
      const part = parts[r];
      const values = [String(r + 1), part.id, part.quantity, part.material, part.processing, part.comment];
      const bgColor = r % 2 === 0 ? '#ffffff' : THEME.altRow;

      // Page break check — repeat header on new page
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 80) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawTableHeader(doc, headers, colWidths, tableLeft, y, rowHeight);
        doc.font('Helvetica').fontSize(8).fillColor(THEME.text);
      }

      let x = tableLeft;
      for (let c = 0; c < values.length; c++) {
        doc.rect(x, y, colWidths[c], rowHeight).fill(bgColor);
        doc.fillColor(THEME.text)
          .text(values[c] || '—', x + 4, y + 8, {
            width: colWidths[c] - 8,
            align: c <= 2 ? 'center' : 'left',
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

    // ─── Terms & Conditions ────────────────────────────────────
    if (doc.y + 100 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }

    doc.fontSize(10).font('Helvetica-Bold').fillColor(THEME.primary)
      .text('Conditions :', marginLeft, doc.y);
    doc.moveDown(0.3);
    doc.fontSize(7.5).font('Helvetica').fillColor(THEME.text);
    for (const term of TERMS) {
      doc.text(`• ${term}`, marginLeft + 10, doc.y, {
        width: contentWidth - 20,
      });
      doc.moveDown(0.15);
    }

    // ─── Footer ────────────────────────────────────────────────
    doc.moveDown(1);
    doc.moveTo(marginLeft, doc.y)
      .lineTo(marginLeft + contentWidth, doc.y)
      .strokeColor(THEME.border).lineWidth(0.5).stroke();
    doc.moveDown(0.3);
    doc.fontSize(6.5).font('Helvetica').fillColor(THEME.muted)
      .text(COMPANY.legal, { align: 'center' })
      .text(COMPANY.website, { align: 'center' });

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

/**
 * Generate a DOCX buffer matching the USI-PRO "Demande de Devis" template.
 */
export async function generateDocx(ofNumber: string, parts: Part[]): Promise<Buffer> {
  const log = ofLogger(ofNumber);
  log.info({ partCount: parts.length }, 'Generating DOCX locally');

  const date = formatDateFR();

  // ─── Header banner (simulated with a full-width table) ──────
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
        shading: { fill: '240C2E', color: 'auto', type: ShadingType.CLEAR },
        verticalAlign: VerticalAlign.CENTER,
        width: { size: 40, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
          bottom: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
          left: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
          right: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
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
        shading: { fill: '240C2E', color: 'auto', type: ShadingType.CLEAR },
        verticalAlign: VerticalAlign.CENTER,
        width: { size: 40, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
          bottom: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
          left: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
          right: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
        },
      }),
    );
  }

  // Title cell
  headerCells.push(
    new TableCell({
      children: [
        new Paragraph({
          children: [
            new TextRun({
              text: 'DEMANDE DE DEVIS',
              bold: true,
              font: 'Arial',
              size: 32,
              color: 'FFFFFF',
            }),
          ],
          alignment: AlignmentType.RIGHT,
        }),
      ],
      shading: { fill: '240C2E', color: 'auto', type: ShadingType.CLEAR },
      verticalAlign: VerticalAlign.CENTER,
      width: { size: 60, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
        bottom: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
        left: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
        right: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
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
      top: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '99EEEB' },
      left: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
      right: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: '240C2E' },
    },
  });

  // ─── Parts table header row ──────────────────────────────────
  const tableHeaders = ['#', 'Référence', 'Quantité', 'Matériau', 'Traitement', 'Commentaires'];
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
          shading: { fill: '240C2E', color: 'auto', type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
        }),
    ),
  });

  // ─── Parts table data rows ───────────────────────────────────
  const dataRows = parts.map((part, i) => {
    const values = [String(i + 1), part.id, part.quantity, part.material, part.processing, part.comment];
    return new TableRow({
      children: values.map(
        (text, colIdx) =>
          new TableCell({
            children: [
              new Paragraph({
                children: [new TextRun({ text: text || '—', font: 'Arial', size: 18 })],
                alignment: colIdx <= 2 ? AlignmentType.CENTER : AlignmentType.LEFT,
              }),
            ],
            shading: i % 2 === 1 ? { fill: 'F5F3F7', color: 'auto', type: ShadingType.CLEAR } : undefined,
            verticalAlign: VerticalAlign.CENTER,
          }),
      ),
    });
  });

  // ─── Terms paragraphs ─────────────────────────────────────────
  const termsParagraphs = TERMS.map(
    (term) =>
      new Paragraph({
        children: [new TextRun({ text: `• ${term}`, font: 'Arial', size: 15, color: '2C2C2C' })],
        spacing: { after: 40 },
        indent: { left: 200 },
      }),
  );

  // ─── Assemble document ────────────────────────────────────────
  const doc = new Document({
    sections: [
      {
        children: [
          // Header banner
          headerBanner,
          // Spacer
          new Paragraph({ spacing: { after: 200 }, children: [] }),
          // Reference & Date
          new Paragraph({
            children: [
              new TextRun({
                text: `Référence : OF${ofNumber}`,
                bold: true,
                font: 'Arial',
                size: 22,
                color: '240C2E',
              }),
              new TextRun({
                text: `\tDate : ${date}`,
                font: 'Arial',
                size: 22,
                color: '2C2C2C',
              }),
            ],
            spacing: { after: 300 },
            tabStops: [{ type: 'right' as any, position: 9000 }],
          }),
          // Parts table
          new Table({
            rows: [partTableHeaderRow, ...dataRows],
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            borders: DOCX_TABLE_BORDERS,
          }),
          // Spacer
          new Paragraph({ spacing: { after: 300 }, children: [] }),
          // Terms header
          new Paragraph({
            children: [
              new TextRun({
                text: 'Conditions :',
                bold: true,
                font: 'Arial',
                size: 18,
                color: '240C2E',
              }),
            ],
            spacing: { after: 80 },
          }),
          // Terms items
          ...termsParagraphs,
          // Spacer
          new Paragraph({ spacing: { after: 200 }, children: [] }),
          // Legal footer
          new Paragraph({
            children: [
              new TextRun({
                text: COMPANY.legal,
                font: 'Arial',
                size: 13,
                color: '666666',
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 20 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: COMPANY.website,
                font: 'Arial',
                size: 13,
                color: '666666',
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
