import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractTextFromPdf } from '../src/services/pdfAnonymizer';

async function mk(ref: string) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([842, 595]).drawText(`PLAN ${ref}`, { x: 48, y: 540, size: 14, font: f });
  return Buffer.from(await d.save());
}

(async () => {
  const a = await mk('AAA-111');
  const b = await mk('BBB-222');
  console.log('octets identiques ?', a.equals(b));

  console.log('\n--- appels séquentiels ---');
  console.log('1er (AAA) :', JSON.stringify((await extractTextFromPdf(a)).trim().slice(0, 40)));
  console.log('2e  (BBB) :', JSON.stringify((await extractTextFromPdf(b)).trim().slice(0, 40)));
  console.log('3e  (AAA) :', JSON.stringify((await extractTextFromPdf(a)).trim().slice(0, 40)));

  console.log('\n--- appels concurrents (comme dans une archive) ---');
  const [x, y] = await Promise.all([extractTextFromPdf(a), extractTextFromPdf(b)]);
  console.log('AAA →', JSON.stringify(x.trim().slice(0, 40)));
  console.log('BBB →', JSON.stringify(y.trim().slice(0, 40)));
})().catch(e => { console.error('ERREUR', e.message); process.exit(1); });
