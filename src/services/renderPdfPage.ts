/**
 * Render a single PDF page to a PNG buffer using pdfjs-dist + @napi-rs/canvas.
 * Returns null if rendering fails (missing optional dep, corrupt PDF, etc.).
 */
export async function renderPageToPng(
  pdfBytes: Buffer,
  pageIndex: number,
  scale: number = 2.0,
): Promise<Buffer | null> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as any);
    const { createCanvas } = await import('@napi-rs/canvas' as any);

    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale });

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
