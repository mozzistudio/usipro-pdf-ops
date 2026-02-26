import { PDFDocument, rgb } from 'pdf-lib';

export interface Zone {
  page: number;   // 0-indexed
  x: number;      // PDF points from left edge
  y: number;      // PDF points from bottom edge (pdf-lib convention)
  width: number;
  height: number;
}

/**
 * Draw white rectangles over the specified zones and return the modified PDF.
 * The original content is visually masked; geometry in other zones is untouched.
 */
export async function applyWhiteZones(pdfBytes: Buffer, zones: Zone[]): Promise<Buffer> {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();

  for (const z of zones) {
    const page = pages[z.page];
    if (!page) continue;
    page.drawRectangle({
      x: z.x,
      y: z.y,
      width: z.width,
      height: z.height,
      color: rgb(1, 1, 1),
      borderWidth: 0,
    });
  }

  const saved = await doc.save();
  return Buffer.from(saved);
}
