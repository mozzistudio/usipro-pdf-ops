/**
 * Empreintes STEP — ce qui doit être reconnu comme la même pièce, et ce qui ne
 * doit pas l'être.
 *
 * Le cas qui compte vraiment est le ré-export : le client renvoie le même
 * modèle, le fichier a changé d'octets, la pièce non. Si l'app ne le voit pas,
 * elle crée un article de plus et le prix historique est perdu.
 *
 * Run: npx ts-node test/step-fingerprint.test.ts
 */

import { compareFingerprints, fingerprintStep } from '../src/services/stepFingerprint';

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

/** Un STEP minimal mais réaliste : en-tête, points, faces, arêtes. */
function makeStep(opts: {
  author?: string;
  startId?: number;
  floats?: 'court' | 'long';
  size?: number;
  extraFace?: boolean;
}): Buffer {
  const { author = 'client', startId = 1, floats = 'court', size = 100, extraFace = false } = opts;
  const fmt = (n: number) => (floats === 'court' ? `${n}.` : n.toFixed(6));

  const corners = [
    [0, 0, 0],
    [size, 0, 0],
    [size, 50, 0],
    [0, 50, 0],
    [0, 0, 20],
    [size, 0, 20],
    [size, 50, 20],
    [0, 50, 20],
  ];

  let id = startId;
  const lines: string[] = [];
  for (const [x, y, z] of corners) {
    lines.push(`#${id++}=CARTESIAN_POINT('',(${fmt(x)},${fmt(y)},${fmt(z)}));`);
  }
  for (let i = 0; i < 6; i++) lines.push(`#${id++}=ADVANCED_FACE('',(#${id}),#${id},.T.);`);
  if (extraFace) lines.push(`#${id++}=ADVANCED_FACE('',(#${id}),#${id},.T.);`);
  for (let i = 0; i < 12; i++) lines.push(`#${id++}=EDGE_CURVE('',#1,#2,#3,.T.);`);
  lines.push(`#${id++}=CLOSED_SHELL('',(#1));`);

  return Buffer.from(
    `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('STEP AP214'),'2;1');
FILE_NAME('piece.step','2026-09-22T10:00:00',('${author}'),('${author} SA'),'','CATIA','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
${lines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`,
    'latin1',
  );
}

console.log('\n─── Lecture des empreintes ─────────────────────────────────');

const base = fingerprintStep(makeStep({}));
assert(base.dataSha256 !== null, 'la géométrie est hachée');
assert(base.pointCount === 8, `8 points lus (obtenu ${base.pointCount})`);
assert(base.entityCounts.ADVANCED_FACE === 6, '6 faces comptées');
assert(base.entityCounts.EDGE_CURVE === 12, '12 arêtes comptées');
assert(
  !!base.bboxMm && base.bboxMm[0] === 100 && base.bboxMm[1] === 50 && base.bboxMm[2] === 20,
  `encombrement 100×50×20 trié (obtenu ${JSON.stringify(base.bboxMm)})`,
);

console.log('\n─── Le même fichier, deux fois ─────────────────────────────');

const same = fingerprintStep(makeStep({}));
const identical = compareFingerprints(base, same);
assert(identical.kind === 'identique', 'deux fichiers identiques : « identique »');
assert(identical.score === 1, 'score maximal');

console.log("\n─── L'en-tête change, pas la pièce ─────────────────────────");

// C'est exactement ce que fait notre propre anonymisation : réécrire l'en-tête.
const anonymized = fingerprintStep(makeStep({ author: '' }));
assert(
  compareFingerprints(base, anonymized).kind === 'identique',
  "un en-tête réécrit ne change pas l'empreinte géométrique",
);

console.log('\n─── Ré-export : mêmes formes, autres octets ────────────────');

const reexported = fingerprintStep(makeStep({ startId: 5000, floats: 'long' }));
assert(
  base.dataSha256 !== reexported.dataSha256,
  'le hash diffère bien (entités renumérotées, flottants reformatés)',
);
const reexport = compareFingerprints(base, reexported);
assert(reexport.kind === 'reexport', 'reconnu comme ré-export, pas comme pièce nouvelle');
assert(
  reexport.reasons.some(r => r.includes('encombrement identique')),
  'la preuve affichée mentionne l’encombrement identique',
);

console.log('\n─── Famille : une cote bouge ───────────────────────────────');

const bigger = fingerprintStep(makeStep({ size: 110 }));
const family = compareFingerprints(base, bigger);
assert(family.kind === 'voisin', 'même forme, une cote différente : « voisin »');
assert(family.score < 0.95, 'un voisin ne vaut jamais un ré-export');

console.log('\n─── Hors domaine et pièce différente ───────────────────────');

const farAway = fingerprintStep(makeStep({ size: 400 }));
assert(
  compareFingerprints(base, farAway).kind === 'different',
  'une cote hors du domaine de la famille n’est plus un voisin',
);

const otherShape = fingerprintStep(makeStep({ extraFace: true }));
assert(
  compareFingerprints(base, otherShape).kind === 'different',
  'une face de plus : pièce différente',
);

console.log('\n─── Fichier inexploitable ──────────────────────────────────');

const empty = fingerprintStep(Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\n', 'latin1'));
assert(empty.dataSha256 === null, 'sans section DATA, aucun hash inventé');
assert(empty.bboxMm === null, 'sans point, aucun encombrement inventé');
assert(
  compareFingerprints(base, empty).kind === 'different',
  'un fichier vide ne se rattache à rien',
);

console.log(`\n─── ${passed} passés, ${failed} échoués ───\n`);
