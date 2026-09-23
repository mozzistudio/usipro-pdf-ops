import crypto from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { extractPdfTextFallback } from '../src/services/pdfTextFallback';

async function plan(ref: string, mat: string) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([842, 595]);
  p.drawRectangle({ x: 24, y: 24, width: 794, height: 547, borderColor: rgb(.1,.1,.1), borderWidth: 1.5 });
  p.drawText(`PLAN ${ref}`, { x: 48, y: 540, size: 14, font: f });
  p.drawText(`Matiere: ${mat}`, { x: 520, y: 62, size: 10, font: f });
  return Buffer.from(await d.save());
}

(async () => {
  const a = await plan('SP-410', 'Acier 42CrMo4');
  const b = await plan('SP-411', 'Bronze CuSn12');
  const h = (x: Buffer) => crypto.createHash('sha1').update(x).digest('hex').slice(0, 10);
  console.log(`a: ${a.length} o ${h(a)} | b: ${b.length} o ${h(b)}`);

  console.log('\nfallback(a) =', JSON.stringify(extractPdfTextFallback(a).replace(/\s+/g, ' ').trim()));
  console.log('fallback(b) =', JSON.stringify(extractPdfTextFallback(b).replace(/\s+/g, ' ').trim()));
})().catch(e => { console.error('ERREUR', e.message); process.exit(1); });
