import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readAttachment } from '../src/services/attachments';
import { extractTextFromPdf } from '../src/services/pdfAnonymizer';

async function plan(ref: string, des: string, mat: string, cotes: string, qte: number) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([842, 595]);
  p.drawRectangle({ x: 24, y: 24, width: 794, height: 547, borderColor: rgb(.1,.1,.1), borderWidth: 1.5 });
  p.drawText(`PLAN ${ref} — ${des}`, { x: 48, y: 540, size: 14, font: f });
  p.drawText(`Matiere: ${mat}`, { x: 520, y: 62, size: 10, font: f });
  p.drawText(`Encombrement: ${cotes}`, { x: 520, y: 44, size: 10, font: f });
  p.drawText(`Qte: ${qte}`, { x: 520, y: 30, size: 10, font: f });
  return Buffer.from(await d.save());
}

(async () => {
  const a = await plan('SP-410', 'Chape de verin', 'Acier 42CrMo4', '260 x 120 x 60 mm', 8);
  const b = await plan('SP-411', 'Bague bronze', 'Bronze CuSn12', '90 x 90 x 35 mm', 24);

  console.log(`lecteur principal (pdf2json) : ${(await extractTextFromPdf(a)).trim().length} car.`);

  for (const [name, bytes] of [['SP-410 chape.pdf', a], ['SP-411 bague.pdf', b]] as const) {
    const r = await readAttachment({ name, size: bytes.length, contentBase64: bytes.toString('base64') });
    console.log(`\n${name} → ${r.text.trim().length} car. | note: ${r.note}`);
    console.log(JSON.stringify(r.text.trim()));
  }
})().catch(e => { console.error('ERREUR', e.message); process.exit(1); });
