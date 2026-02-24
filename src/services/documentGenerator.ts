import PDFDocument from 'pdfkit';
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  AlignmentType,
  HeadingLevel,
} from 'docx';
import { Part } from '../types';
import { formatDateFR } from '../utils/helpers';
import { ofLogger } from '../utils/logger';

// ─── PDF Generation (pdfkit) ────────────────────────────────────────────────

/**
 * Generate a PDF buffer for the OF document.
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

    // ─── Title ────────────────────────────────────────────────────
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#240C2E')
      .text(`Ordre de Fabrication — ${ofNumber}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(11).font('Helvetica').fillColor('#666666')
      .text(`Date : ${date}`, { align: 'center' });
    doc.moveDown(1);

    // ─── Table ────────────────────────────────────────────────────
    const headers = ['#', 'Réf', 'Matériel', 'Qté', 'Traitement', 'Commentaire'];
    const colWidths = [28, 60, 120, 35, 110, 160];
    const tableLeft = doc.page.margins.left;
    const rowHeight = 22;

    // Header row
    let x = tableLeft;
    let y = doc.y;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff');
    for (let c = 0; c < headers.length; c++) {
      doc.rect(x, y, colWidths[c], rowHeight).fill('#240C2E');
      doc.fillColor('#ffffff')
        .text(headers[c], x + 3, y + 6, { width: colWidths[c] - 6, align: 'center' });
      x += colWidths[c];
    }
    y += rowHeight;

    // Data rows
    doc.font('Helvetica').fontSize(8).fillColor('#2c2c2c');
    for (let r = 0; r < parts.length; r++) {
      const part = parts[r];
      const values = [String(r + 1), part.id, part.material, part.quantity, part.processing, part.comment];
      const bgColor = r % 2 === 0 ? '#ffffff' : '#f5f3f7';

      // Check for page break
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      x = tableLeft;
      for (let c = 0; c < values.length; c++) {
        doc.rect(x, y, colWidths[c], rowHeight).fill(bgColor);
        doc.fillColor('#2c2c2c')
          .text(values[c] || '', x + 3, y + 6, { width: colWidths[c] - 6, align: c === 0 || c === 3 ? 'center' : 'left' });
        x += colWidths[c];
      }

      // Cell borders
      x = tableLeft;
      for (let c = 0; c < colWidths.length; c++) {
        doc.rect(x, y, colWidths[c], rowHeight).strokeColor('#cccccc').stroke();
        x += colWidths[c];
      }

      y += rowHeight;
    }

    doc.end();
  });
}

// ─── DOCX Generation ────────────────────────────────────────────────────────

/**
 * Generate a DOCX buffer for the OF document.
 */
export async function generateDocx(ofNumber: string, parts: Part[]): Promise<Buffer> {
  const log = ofLogger(ofNumber);
  log.info({ partCount: parts.length }, 'Generating DOCX locally');

  const date = formatDateFR();

  // Header row
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['#', 'Référence', 'Matériel', 'Quantité', 'Traitement', 'Commentaire'].map(
      (text) =>
        new TableCell({
          children: [
            new Paragraph({
              children: [new TextRun({ text, bold: true, font: 'Arial', size: 18, color: '240C2E' })],
              alignment: AlignmentType.CENTER,
            }),
          ],
          shading: { fill: 'E8E0ED', color: 'auto', type: 'clear' as any },
        }),
    ),
  });

  // Data rows
  const dataRows = parts.map((part, i) => {
    const values = [String(i + 1), part.id, part.material, part.quantity, part.processing, part.comment];
    return new TableRow({
      children: values.map(
        (text, colIdx) =>
          new TableCell({
            children: [
              new Paragraph({
                children: [new TextRun({ text: text || '', font: 'Arial', size: 18 })],
                alignment: colIdx === 0 || colIdx === 3 ? AlignmentType.CENTER : AlignmentType.LEFT,
              }),
            ],
          }),
      ),
    });
  });

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: `Ordre de Fabrication — ${ofNumber}`,
                bold: true,
                font: 'Arial',
                size: 32,
                color: '240C2E',
              }),
            ],
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            spacing: { after: 100 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `Date : ${date}`,
                font: 'Arial',
                size: 22,
                color: '666666',
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
          }),
          new Table({
            rows: [headerRow, ...dataRows],
            width: { size: 100, type: WidthType.PERCENTAGE },
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  log.info({ sizeBytes: buffer.length }, 'DOCX generated');
  return buffer;
}
