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
  tagline: 'Precision CNC Machining',
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

// ─── Theme ──────────────────────────────────────────────────────────────────

const THEME = {
  primary: '#240C2E',
  headerBg: '#240C2E',
  headerText: '#ffffff',
  altRow: '#f5f3f7',
  text: '#2c2c2c',
  muted: '#666666',
  border: '#cccccc',
  lightPurple: 'E8E0ED',
};

// ─── PDF Generation (pdfkit) ────────────────────────────────────────────────

/**
 * Generate a PDF buffer matching the USI-PRO quote template.
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

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // ─── Company Header ──────────────────────────────────────────
    const logoBuffer = loadLogo();
    if (logoBuffer) {
      doc.image(logoBuffer, doc.page.margins.left, doc.y, { height: 50 });
      doc.y += 55;
    } else {
      doc.fontSize(20).font('Helvetica-Bold').fillColor(THEME.primary)
        .text(COMPANY.name, { align: 'left' });
    }
    doc.fontSize(9).font('Helvetica').fillColor(THEME.muted)
      .text(COMPANY.tagline);
    doc.moveDown(0.3);
    doc.fontSize(8).fillColor(THEME.text)
      .text(COMPANY.address)
      .text(`${COMPANY.email} | ${COMPANY.phone}`)
      .text(COMPANY.website);
    doc.moveDown(0.5);

    // Separator line
    doc.moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.margins.left + pageWidth, doc.y)
      .strokeColor(THEME.primary).lineWidth(1.5).stroke();
    doc.moveDown(0.8);

    // ─── Reference & Date ────────────────────────────────────────
    doc.fontSize(11).font('Helvetica-Bold').fillColor(THEME.primary)
      .text(`Référence : ${ofNumber}`, doc.page.margins.left, doc.y, { continued: true })
      .font('Helvetica').fillColor(THEME.text)
      .text(`    |    Date : ${date}`);
    doc.moveDown(1);

    // ─── Parts Table ─────────────────────────────────────────────
    const headers = ['Référence', 'Quantité', 'Matériau', 'Traitement', 'Commentaires'];
    const colWidths = [80, 60, 100, 110, pageWidth - 80 - 60 - 100 - 110];
    const tableLeft = doc.page.margins.left;
    const rowHeight = 22;

    // Header row
    let x = tableLeft;
    let y = doc.y;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(THEME.headerText);
    for (let c = 0; c < headers.length; c++) {
      doc.rect(x, y, colWidths[c], rowHeight).fill(THEME.headerBg);
      doc.fillColor(THEME.headerText)
        .text(headers[c], x + 4, y + 6, { width: colWidths[c] - 8, align: 'center' });
      x += colWidths[c];
    }
    y += rowHeight;

    // Data rows
    doc.font('Helvetica').fontSize(8).fillColor(THEME.text);
    for (let r = 0; r < parts.length; r++) {
      const part = parts[r];
      const values = [part.id, part.quantity, part.material, part.processing, part.comment];
      const bgColor = r % 2 === 0 ? '#ffffff' : THEME.altRow;

      // Check for page break
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 80) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      x = tableLeft;
      for (let c = 0; c < values.length; c++) {
        doc.rect(x, y, colWidths[c], rowHeight).fill(bgColor);
        doc.fillColor(THEME.text)
          .text(values[c] || '—', x + 4, y + 6, {
            width: colWidths[c] - 8,
            align: c <= 1 ? 'center' : 'left',
          });
        x += colWidths[c];
      }

      // Cell borders
      x = tableLeft;
      for (let c = 0; c < colWidths.length; c++) {
        doc.rect(x, y, colWidths[c], rowHeight).strokeColor(THEME.border).stroke();
        x += colWidths[c];
      }

      y += rowHeight;
    }

    doc.moveDown(1.5);

    // ─── Terms & Conditions ──────────────────────────────────────
    // Check for page break before terms
    if (doc.y + 100 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }

    doc.fontSize(9).font('Helvetica-Bold').fillColor(THEME.primary)
      .text('Conditions :', doc.page.margins.left, doc.y);
    doc.moveDown(0.3);
    doc.fontSize(7.5).font('Helvetica').fillColor(THEME.text);
    for (const term of TERMS) {
      doc.text(`• ${term}`, doc.page.margins.left + 10, doc.y, {
        width: pageWidth - 20,
      });
      doc.moveDown(0.15);
    }

    // ─── Footer ──────────────────────────────────────────────────
    doc.moveDown(1);
    doc.moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.margins.left + pageWidth, doc.y)
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
  color: 'CCCCCC',
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
 * Generate a DOCX buffer matching the USI-PRO quote template.
 */
export async function generateDocx(ofNumber: string, parts: Part[]): Promise<Buffer> {
  const log = ofLogger(ofNumber);
  log.info({ partCount: parts.length }, 'Generating DOCX locally');

  const date = formatDateFR();

  // ─── Table header row ──────────────────────────────────────────
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['Référence', 'Quantité', 'Matériau', 'Traitement', 'Commentaires'].map(
      (text) =>
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text, bold: true, font: 'Arial', size: 18, color: 'FFFFFF' })],
              alignment: AlignmentType.CENTER,
            }),
          ],
          shading: { fill: '240C2E', color: 'auto', type: 'clear' as any },
          verticalAlign: VerticalAlign.CENTER,
        }),
    ),
  });

  // ─── Table data rows ───────────────────────────────────────────
  const dataRows = parts.map((part, i) => {
    const values = [part.id, part.quantity, part.material, part.processing, part.comment];
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
            shading: i % 2 === 1 ? { fill: 'F5F3F7', color: 'auto', type: 'clear' as any } : undefined,
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

  // ─── Logo for DOCX ──────────────────────────────────────────
  const logoBuffer = loadLogo();
  const logoElements: Paragraph[] = [];
  if (logoBuffer) {
    logoElements.push(
      new Paragraph({
        children: [
          new ImageRun({
            data: logoBuffer,
            transformation: { width: 160, height: 50 },
            type: 'png',
          }),
        ],
        spacing: { after: 40 },
      }),
    );
  } else {
    logoElements.push(
      new Paragraph({
        children: [
          new TextRun({
            text: COMPANY.name,
            bold: true,
            font: 'Arial',
            size: 36,
            color: '240C2E',
          }),
        ],
        spacing: { after: 40 },
      }),
    );
  }

  // ─── Assemble document ────────────────────────────────────────
  const doc = new Document({
    sections: [
      {
        children: [
          // Company logo or name
          ...logoElements,
          // Tagline
          new Paragraph({
            children: [
              new TextRun({
                text: COMPANY.tagline,
                font: 'Arial',
                size: 18,
                color: '666666',
                italics: true,
              }),
            ],
            spacing: { after: 60 },
          }),
          // Address
          new Paragraph({
            children: [
              new TextRun({ text: COMPANY.address, font: 'Arial', size: 16, color: '2C2C2C' }),
            ],
            spacing: { after: 20 },
          }),
          // Contact
          new Paragraph({
            children: [
              new TextRun({ text: `${COMPANY.email} | ${COMPANY.phone}`, font: 'Arial', size: 16, color: '2C2C2C' }),
            ],
            spacing: { after: 20 },
          }),
          // Website
          new Paragraph({
            children: [
              new TextRun({ text: COMPANY.website, font: 'Arial', size: 16, color: '240C2E' }),
            ],
            spacing: { after: 200 },
          }),
          // Reference & Date
          new Paragraph({
            children: [
              new TextRun({
                text: `Référence : ${ofNumber}`,
                bold: true,
                font: 'Arial',
                size: 22,
                color: '240C2E',
              }),
              new TextRun({
                text: `    |    Date : ${date}`,
                font: 'Arial',
                size: 22,
                color: '2C2C2C',
              }),
            ],
            spacing: { after: 300 },
          }),
          // Parts table
          new Table({
            rows: [headerRow, ...dataRows],
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
