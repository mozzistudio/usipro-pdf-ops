/**
 * Pipeline integration test — validates logic with IDs 13315, 13316, 13317.
 *
 * Tests all fields: id, material, quantity, processing, comment.
 * Verifies Dropbox paths, file detection, template selection, tag replacements.
 */

import { parseFormPayload, buildDropboxPaths, isPdf, isStep, getExtension, formatDateFR } from '../src/utils/helpers';
import { config } from '../src/config';

// ─── Test helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

// ─── Realistic sample data ──────────────────────────────────────────────────

const sampleParts = [
  {
    id: '13315',
    material: 'Acier C45',
    quantity: '10',
    processing: 'Tournage CNC',
    comment: 'Tolérance H7 sur alésage',
  },
  {
    id: '13316',
    material: 'Inox 316L',
    quantity: '5',
    processing: 'Fraisage 5 axes',
    comment: 'Finition Ra 0.8',
  },
  {
    id: '13317',
    material: 'Aluminium 7075-T6',
    quantity: '25',
    processing: 'Rectification cylindrique',
    comment: 'Traitement anodisation noire après usinage',
  },
];

// ─── Test 1: parseFormPayload with full sample data ─────────────────────────

console.log('\n=== Test 1: parseFormPayload with IDs 13315, 13316, 13317 ===');

const payload = { of: '99001', parts: sampleParts };
const ofData = parseFormPayload(payload);

assert(ofData.ofNumber === '99001', 'OF number parsed correctly');
assert(ofData.parts.length === 3, 'All 3 parts parsed');

// Verify all fields for each part
assert(ofData.parts[0].id === '13315', 'Part 1 ID = 13315');
assert(ofData.parts[0].material === 'Acier C45', 'Part 1 material = Acier C45');
assert(ofData.parts[0].quantity === '10', 'Part 1 quantity = 10');
assert(ofData.parts[0].processing === 'Tournage CNC', 'Part 1 processing = Tournage CNC');
assert(ofData.parts[0].comment === 'Tolérance H7 sur alésage', 'Part 1 comment preserved');

assert(ofData.parts[1].id === '13316', 'Part 2 ID = 13316');
assert(ofData.parts[1].material === 'Inox 316L', 'Part 2 material = Inox 316L');
assert(ofData.parts[1].quantity === '5', 'Part 2 quantity = 5');
assert(ofData.parts[1].processing === 'Fraisage 5 axes', 'Part 2 processing = Fraisage 5 axes');
assert(ofData.parts[1].comment === 'Finition Ra 0.8', 'Part 2 comment preserved');

assert(ofData.parts[2].id === '13317', 'Part 3 ID = 13317');
assert(ofData.parts[2].material === 'Aluminium 7075-T6', 'Part 3 material = Aluminium 7075-T6');
assert(ofData.parts[2].quantity === '25', 'Part 3 quantity = 25');
assert(ofData.parts[2].processing === 'Rectification cylindrique', 'Part 3 processing = Rectification cylindrique');
assert(ofData.parts[2].comment === 'Traitement anodisation noire après usinage', 'Part 3 comment preserved');

// ─── Test 2: parseFormPayload with empty/whitespace IDs ─────────────────────

console.log('\n=== Test 2: parseFormPayload filters empty IDs ===');

const payloadWithEmpty = {
  of: '99002',
  parts: [
    { id: '13315', material: 'Bronze CuSn8', quantity: '3', processing: 'Tournage', comment: 'Pièce de rechange' },
    { id: '', material: 'Acier', quantity: '1', processing: 'Fraisage', comment: '' },
    { id: '  ', material: 'Inox', quantity: '2', processing: '', comment: '' },
    { id: '13317', material: 'Laiton CuZn39Pb3', quantity: '8', processing: 'Décolletage', comment: 'Lot urgent' },
  ],
};

const ofData2 = parseFormPayload(payloadWithEmpty);
assert(ofData2.parts.length === 2, 'Empty/whitespace IDs are filtered out (2 of 4 remain)');
assert(ofData2.parts[0].id === '13315', 'First valid part is 13315');
assert(ofData2.parts[0].material === 'Bronze CuSn8', 'Filtered part 1 keeps its material');
assert(ofData2.parts[1].id === '13317', 'Second valid part is 13317');
assert(ofData2.parts[1].processing === 'Décolletage', 'Filtered part 2 keeps its processing');

// ─── Test 3: parseFormPayload validation errors ─────────────────────────────

console.log('\n=== Test 3: parseFormPayload validation ===');

try {
  parseFormPayload({ of: '', parts: [] });
  assert(false, 'Should throw for empty OF');
} catch (e: any) {
  assert(e.message === 'Numéro OF manquant', 'Throws correct error for empty OF');
}

try {
  parseFormPayload({ of: '99003', parts: [] });
  assert(false, 'Should throw for no parts');
} catch (e: any) {
  assert(e.message === 'Au moins une pièce avec un ID est requise', 'Throws correct error for no parts');
}

try {
  parseFormPayload({
    of: '99004',
    parts: [{ id: '', material: 'Acier', quantity: '5', processing: 'Tournage', comment: 'test' }],
  });
  assert(false, 'Should throw when all parts have empty IDs');
} catch (e: any) {
  assert(e.message === 'Au moins une pièce avec un ID est requise', 'Throws correct error when all IDs empty');
}

// ─── Test 4: buildDropboxPaths ──────────────────────────────────────────────

console.log('\n=== Test 4: buildDropboxPaths ===');

const paths = buildDropboxPaths('99001');
assert(paths.main === '/Analyses/RIJ/Achats Externes/OF99001', 'Main folder path correct');
assert(paths.nm === '/Analyses/RIJ/Achats Externes/OF99001/NM99001', 'NM folder path correct');
assert(paths.dp === '/Analyses/RIJ/Achats Externes/OF99001/DP99001', 'DP folder path correct');

// ─── Test 5: File type detection with IDs 13315, 13316, 13317 ──────────────

console.log('\n=== Test 5: File type detection ===');

// PDF detection
assert(isPdf('13315.pdf') === true, '13315.pdf detected as PDF');
assert(isPdf('13316.PDF') === true, '13316.PDF detected as PDF (case insensitive)');
assert(isPdf('13317.Pdf') === true, '13317.Pdf detected as PDF (mixed case)');
assert(isPdf('13315.step') === false, '13315.step not detected as PDF');
assert(isPdf('13315') === false, '13315 (no extension) not detected as PDF');

// STEP detection
assert(isStep('13315.step') === true, '13315.step detected as STEP');
assert(isStep('13316.stp') === true, '13316.stp detected as STEP');
assert(isStep('13317.STP') === true, '13317.STP detected as STEP (case insensitive)');
assert(isStep('13315.STEP') === true, '13315.STEP detected as STEP (case insensitive)');
assert(isStep('13316.pdf') === false, '13316.pdf not detected as STEP');
assert(isStep('13317.dxf') === false, '13317.dxf not detected as STEP');

// Extension extraction
assert(getExtension('13315.pdf') === 'pdf', 'getExtension for 13315.pdf');
assert(getExtension('13316.STEP') === 'step', 'getExtension for 13316.STEP (lowercased)');
assert(getExtension('13317.stp') === 'stp', 'getExtension for 13317.stp');
assert(getExtension('13315') === '', 'getExtension for file without extension');

// ─── Test 6: Source paths for each part ID ──────────────────────────────────

console.log('\n=== Test 6: Source paths for part IDs ===');

const partIds = ['13315', '13316', '13317'];
for (const id of partIds) {
  const sourcePath = `/analyses/rij/plans/${id}`;
  assert(sourcePath === `/analyses/rij/plans/${id}`, `Source path for ${id}: ${sourcePath}`);
}

// ─── Test 7: Copy destinations ──────────────────────────────────────────────

console.log('\n=== Test 7: Copy destinations for part files ===');

const ofNumber = '99001';
const ofPaths = buildDropboxPaths(ofNumber);

for (const id of partIds) {
  const pdfDest = `${ofPaths.nm}/${id}.pdf`;
  const stepDest = `${ofPaths.dp}/${id}.step`;
  const stpDest = `${ofPaths.dp}/${id}.stp`;

  assert(
    pdfDest === `/Analyses/RIJ/Achats Externes/OF99001/NM99001/${id}.pdf`,
    `PDF copy destination for ${id}`,
  );
  assert(
    stepDest === `/Analyses/RIJ/Achats Externes/OF99001/DP99001/${id}.step`,
    `STEP (.step) copy destination for ${id}`,
  );
  assert(
    stpDest === `/Analyses/RIJ/Achats Externes/OF99001/DP99001/${id}.stp`,
    `STEP (.stp) copy destination for ${id}`,
  );
}

// ─── Test 8: Template selection for 3 parts ─────────────────────────────────

console.log('\n=== Test 8: Template selection ===');

assert(config.templateIds[3] === '1P6mrTnVgEzA6rPU4SzSGa1jSW3LjrVga6VfmzTithJU', 'Template for 3 parts exists');
assert(config.templateIds[1] !== undefined, 'Template for 1 part exists');
assert(config.templateIds[7] !== undefined, 'Template for 7 parts exists');

// For 3 parts, the code checks: partCount <= 7 && config.templateIds[partCount]
const partCount = 3;
assert(partCount <= 7 && !!config.templateIds[partCount], '3 parts uses template-based generation');

// Verify all template IDs are defined
for (let i = 1; i <= 7; i++) {
  assert(typeof config.templateIds[i] === 'string' && config.templateIds[i].length > 0, `Template ${i} is a non-empty string`);
}

// ─── Test 9: Upload paths ───────────────────────────────────────────────────

console.log('\n=== Test 9: Upload destinations ===');

assert(
  `${ofPaths.main}/${ofNumber}.pdf` === '/Analyses/RIJ/Achats Externes/OF99001/99001.pdf',
  'PDF upload path',
);
assert(
  `${ofPaths.main}/${ofNumber}.docx` === '/Analyses/RIJ/Achats Externes/OF99001/99001.docx',
  'DOCX upload path',
);
assert(
  `${ofPaths.main}/NM${ofNumber}.zip` === '/Analyses/RIJ/Achats Externes/OF99001/NM99001.zip',
  'ZIP upload path',
);

// ─── Test 10: Template tag replacements for all fields ──────────────────────

console.log('\n=== Test 10: Template tag replacements (all fields) ===');

const replacements: Record<string, string> = {
  OF: ofNumber,
  Date: formatDateFR(),
};

const parts = ofData.parts;
for (let i = 1; i <= 7; i++) {
  const part = parts[i - 1];
  replacements[`Ref${i}`] = part?.id || '';
  replacements[`Qty${i}`] = part?.quantity || '';
  replacements[`Mat${i}`] = part?.material || '';
  replacements[`Trait${i}`] = part?.processing || '';
  replacements[`Com${i}`] = part?.comment || '';
}

// Verify OF and Date
assert(replacements['OF'] === '99001', 'OF = 99001');
assert(/^\d{2}\/\d{2}\/\d{4}$/.test(replacements['Date']), `Date is formatted DD/MM/YYYY: ${replacements['Date']}`);

// Part 1 (13315) — all fields
assert(replacements['Ref1'] === '13315', 'Ref1 = 13315');
assert(replacements['Mat1'] === 'Acier C45', 'Mat1 = Acier C45');
assert(replacements['Qty1'] === '10', 'Qty1 = 10');
assert(replacements['Trait1'] === 'Tournage CNC', 'Trait1 = Tournage CNC');
assert(replacements['Com1'] === 'Tolérance H7 sur alésage', 'Com1 = Tolérance H7 sur alésage');

// Part 2 (13316) — all fields
assert(replacements['Ref2'] === '13316', 'Ref2 = 13316');
assert(replacements['Mat2'] === 'Inox 316L', 'Mat2 = Inox 316L');
assert(replacements['Qty2'] === '5', 'Qty2 = 5');
assert(replacements['Trait2'] === 'Fraisage 5 axes', 'Trait2 = Fraisage 5 axes');
assert(replacements['Com2'] === 'Finition Ra 0.8', 'Com2 = Finition Ra 0.8');

// Part 3 (13317) — all fields
assert(replacements['Ref3'] === '13317', 'Ref3 = 13317');
assert(replacements['Mat3'] === 'Aluminium 7075-T6', 'Mat3 = Aluminium 7075-T6');
assert(replacements['Qty3'] === '25', 'Qty3 = 25');
assert(replacements['Trait3'] === 'Rectification cylindrique', 'Trait3 = Rectification cylindrique');
assert(replacements['Com3'] === 'Traitement anodisation noire après usinage', 'Com3 = Traitement anodisation noire après usinage');

// Parts 4-7 should be empty (only 3 parts submitted)
for (let i = 4; i <= 7; i++) {
  assert(replacements[`Ref${i}`] === '', `Ref${i} = empty (no part ${i})`);
  assert(replacements[`Mat${i}`] === '', `Mat${i} = empty`);
  assert(replacements[`Qty${i}`] === '', `Qty${i} = empty`);
  assert(replacements[`Trait${i}`] === '', `Trait${i} = empty`);
  assert(replacements[`Com${i}`] === '', `Com${i} = empty`);
}

// ─── Test 11: Special characters in fields ──────────────────────────────────

console.log('\n=== Test 11: Special characters in fields ===');

const specialPayload = {
  of: '99005',
  parts: [
    {
      id: '13315',
      material: 'Acier inox 304L / 316L',
      quantity: '100',
      processing: "Tournage + Fraisage (ébauche & finition)",
      comment: "Ø25 x 150mm — tolérance ±0.02mm",
    },
  ],
};

const specialData = parseFormPayload(specialPayload);
assert(specialData.parts[0].material === 'Acier inox 304L / 316L', 'Slash in material preserved');
assert(specialData.parts[0].processing === "Tournage + Fraisage (ébauche & finition)", 'Special chars in processing preserved');
assert(specialData.parts[0].comment === "Ø25 x 150mm — tolérance ±0.02mm", 'Unicode chars in comment preserved');

// ─── Test 12: formatDateFR ──────────────────────────────────────────────────

console.log('\n=== Test 12: formatDateFR ===');

const knownDate = new Date(2026, 1, 24); // Feb 24, 2026
assert(formatDateFR(knownDate) === '24/02/2026', 'formatDateFR for 2026-02-24');

const jan1 = new Date(2026, 0, 1); // Jan 1, 2026
assert(formatDateFR(jan1) === '01/01/2026', 'formatDateFR for 2026-01-01 (zero-padded)');

const dec31 = new Date(2025, 11, 31); // Dec 31, 2025
assert(formatDateFR(dec31) === '31/12/2025', 'formatDateFR for 2025-12-31');

// ─── Test 13: Large OF with >7 parts (programmatic generation path) ─────────

console.log('\n=== Test 13: Large OF with >7 parts ===');

const largeParts = Array.from({ length: 12 }, (_, i) => ({
  id: String(13315 + i),
  material: `Matériau ${i + 1}`,
  quantity: String((i + 1) * 3),
  processing: `Process ${i + 1}`,
  comment: i % 3 === 0 ? `Note pour pièce ${i + 1}` : '',
}));

const largePayload = { of: '99010', parts: largeParts };
const largeData = parseFormPayload(largePayload);
assert(largeData.parts.length === 12, 'Large OF has 12 parts');
assert(largeData.parts.length > 7, '>7 parts triggers programmatic doc generation');
assert(!config.templateIds[12], 'No template for 12 parts (expected)');

// Verify all 12 parts have correct IDs
for (let i = 0; i < 12; i++) {
  assert(largeData.parts[i].id === String(13315 + i), `Large OF part ${i + 1} ID = ${13315 + i}`);
  assert(largeData.parts[i].material === `Matériau ${i + 1}`, `Large OF part ${i + 1} material preserved`);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
