import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { extractTextFromPdf } from '../src/services/pdfAnonymizer';

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

  for (const [n, [name, bytes]] of [['A=SP-410', a], ['B=SP-411', b], ['A=SP-410 (bis)', a]].entries() as any) {
    const t = (await extractTextFromPdf(bytes)).trim().replace(/\s+/g, ' ');
    console.log(`${n + 1}. ${name} → ${JSON.stringify(t.slice(0, 60))}`);
  }
})().catch(e => { console.error('ERREUR', e.message); process.exit(1); });
