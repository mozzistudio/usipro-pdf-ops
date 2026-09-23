/**
 * Rattachement au référentiel article — contre la vraie base.
 *
 * Ce que le test vérifie est la promesse du catalogue : une pièce déjà passée
 * est reconnue même quand le fichier a changé d'octets, et une géométrie
 * identique portée par une autre référence n'est JAMAIS fusionnée en silence.
 *
 * Nécessite SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY ; sans elles, le test se
 * déclare ignoré plutôt que de faire semblant de passer.
 * Les données créées sont supprimées à la fin.
 *
 * Run: npx ts-node test/attachment.test.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { attachPart } from '../src/services/articleStore';
import { supabase } from '../src/services/supabaseClient';

const CLIENT = 'ZZ_TEST_CLIENT';

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

/** Même générateur que le test d'empreintes : un STEP court mais crédible. */
function makeStep(opts: { startId?: number; floats?: 'court' | 'long'; size?: number } = {}): Buffer {
  const { startId = 1, floats = 'court', size = 100 } = opts;
  const fmt = (n: number) => (floats === 'court' ? `${n}.` : n.toFixed(6));
  const corners = [
    [0, 0, 0], [size, 0, 0], [size, 50, 0], [0, 50, 0],
    [0, 0, 20], [size, 0, 20], [size, 50, 20], [0, 50, 20],
  ];

  let id = startId;
  const lines: string[] = [];
  for (const [x, y, z] of corners) {
    lines.push(`#${id++}=CARTESIAN_POINT('',(${fmt(x)},${fmt(y)},${fmt(z)}));`);
  }
  for (let i = 0; i < 6; i++) lines.push(`#${id++}=ADVANCED_FACE('',(#${id}),#${id},.T.);`);
  for (let i = 0; i < 12; i++) lines.push(`#${id++}=EDGE_CURVE('',#1,#2,#3,.T.);`);

  return Buffer.from(
    `ISO-10303-21;\nHEADER;\nFILE_NAME('p.step','2026-09-22T10:00:00',(''),(''),'','CATIA','');\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`,
    'latin1',
  );
}

async function cleanup(): Promise<void> {
  const db = supabase();
  if (!db) return;
  const { data } = await db.from('articles').select('id').eq('client', CLIENT);
  for (const row of (data ?? []) as Array<{ id: string }>) {
    await db.from('articles').delete().eq('id', row.id); // versions en cascade
  }
}

async function main(): Promise<void> {
  if (!supabase()) {
    console.log('\n  IGNORÉ : Supabase non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).\n');
    return;
  }

  await cleanup();

  console.log('\n─── Première fois qu’une pièce passe ───────────────────────');

  const first = await attachPart({
    client: CLIENT, reference: 'T-1000', sourceOf: 'OFTEST-A', stepBytes: makeStep(),
  });
  assert(first.mode === 'auto', 'pièce inconnue : mode auto, rien à arbitrer');
  assert(
    first.summary.includes('Aucune référence historique'),
    `le devis peut annoncer l’absence d’historique (obtenu: "${first.summary}")`,
  );
  assert(first.history.length === 0, 'aucun passage antérieur');

  console.log('\n─── La même pièce revient à l’identique ────────────────────');

  const again = await attachPart({
    client: CLIENT, reference: 'T-1000', sourceOf: 'OFTEST-B', stepBytes: makeStep(),
  });
  assert(again.mode === 'auto', 'réassort : aucun arbitrage demandé');
  assert(again.summary.startsWith('Déjà vue le'), `l’opérateur lit « déjà vue » (obtenu: "${again.summary}")`);
  assert(again.article.id === first.article.id, 'rattachée au même article, pas à un doublon');

  console.log('\n─── Ré-export : autres octets, même pièce ──────────────────');

  const reexport = await attachPart({
    client: CLIENT,
    reference: 'T-1000',
    sourceOf: 'OFTEST-C',
    stepBytes: makeStep({ startId: 9000, floats: 'long' }),
  });
  assert(reexport.mode === 'auto', 'un ré-export ne déclenche pas de question');
  assert(
    reexport.summary.includes('ré-exporté'),
    `l’app explique pourquoi le fichier diffère (obtenu: "${reexport.summary}")`,
  );

  console.log('\n─── Même géométrie, autre référence ────────────────────────');

  const twin = await attachPart({
    client: CLIENT, reference: 'T-2000', sourceOf: 'OFTEST-D', stepBytes: makeStep(),
  });
  assert(twin.mode === 'proposition', 'jamais de fusion automatique entre deux références');
  assert(
    twin.summary.includes('T-1000') && twin.summary.includes('rattacher'),
    `la question nomme l’autre référence (obtenu: "${twin.summary}")`,
  );
  assert(twin.article.reference === 'T-2000', 'la pièce reste sur son propre article tant que rien n’est tranché');
  assert(
    twin.candidates.some(c => !c.sameArticle && c.reasons.length > 0),
    'le candidat arrive avec ses preuves',
  );

  console.log('\n─── Même forme, une cote qui bouge ─────────────────────────');

  const family = await attachPart({
    client: CLIENT, reference: 'T-3000', sourceOf: 'OFTEST-E', stepBytes: makeStep({ size: 110 }),
  });
  assert(family.mode === 'proposition', 'une famille paramétrique se propose, ne se décide pas');
  assert(
    family.candidates.some(c => c.kind === 'voisin'),
    'le voisin est présenté comme voisin, pas comme identique',
  );

  console.log('\n─── Pièce sans modèle 3D ───────────────────────────────────');

  const noStep = await attachPart({
    client: CLIENT, reference: 'T-4000', sourceOf: 'OFTEST-F',
  });
  assert(noStep.mode === 'proposition', 'sans géométrie, l’app ne conclut pas');
  assert(
    noStep.summary.includes('Aucun modèle 3D'),
    `elle dit ce qui lui manque (obtenu: "${noStep.summary}")`,
  );

  await cleanup();

  const db = supabase();
  const { data: left } = await db!.from('articles').select('id').eq('client', CLIENT);
  assert((left ?? []).length === 0, 'les données de test sont supprimées');

  console.log(`\n─── ${passed} passés, ${failed} échoués ───\n`);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exitCode = 1;
});
