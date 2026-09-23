/**
 * Déménagement du schéma `usipro` d'Orkasa vers le projet Supabase dédié.
 *
 * Le DDL est rejoué à part (migration/01_schema.sql) ; ce script ne transporte
 * que ce qui ne se recrée pas : les lignes et les fichiers. Il est idempotent —
 * chaque table est upsertée sur sa clé primaire, chaque objet réuploadé avec
 * `upsert: true` — donc relançable sans doublonner si un transfert coupe.
 *
 *   SOURCE_URL / SOURCE_KEY   projet Orkasa      (repris de .env par défaut)
 *   TARGET_URL / TARGET_KEY   projet USI-PRO     (à fournir)
 */
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const BUCKET = 'usipro-files';

/** L'ordre compte : une table fille ne peut pas précéder sa mère. */
const TABLES = [
  { name: 'works', pk: 'id' },
  { name: 'work_files', pk: 'id' },
  { name: 'request_lines', pk: 'id' },
  { name: 'feedback', pk: 'id' },
  { name: 'articles', pk: 'id' },
  { name: 'article_versions', pk: 'id' },
  { name: 'quotes', pk: 'id' },
  { name: 'client_pricing', pk: 'client' },
  { name: 'pricing_settings', pk: 'id' },
  { name: 'material_rates', pk: 'id' },
];

const sourceUrl = process.env.SOURCE_URL || process.env.SUPABASE_URL;
const sourceKey = process.env.SOURCE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const targetUrl = process.env.TARGET_URL;
const targetKey = process.env.TARGET_KEY;

for (const [label, value] of [['SOURCE_URL', sourceUrl], ['SOURCE_KEY', sourceKey], ['TARGET_URL', targetUrl], ['TARGET_KEY', targetKey]]) {
  if (!value) { console.error(`${label} manquante.`); process.exit(1); }
}
if (sourceUrl === targetUrl) { console.error('Source et cible sont le même projet.'); process.exit(1); }

const opts = { db: { schema: 'usipro' }, auth: { persistSession: false } };
const src = createClient(sourceUrl, sourceKey, opts);
const dst = createClient(targetUrl, targetKey, opts);
const srcFiles = createClient(sourceUrl, sourceKey, { auth: { persistSession: false } });
const dstFiles = createClient(targetUrl, targetKey, { auth: { persistSession: false } });

async function copyTables() {
  for (const { name, pk } of TABLES) {
    const { data, error } = await src.from(name).select('*');
    if (error) throw new Error(`lecture ${name}: ${error.message}`);
    if (!data.length) { console.log(`  ${name.padEnd(17)} vide`); continue; }

    const { error: writeError } = await dst.from(name).upsert(data, { onConflict: pk });
    if (writeError) throw new Error(`écriture ${name}: ${writeError.message}`);

    const { count, error: countError } = await dst.from(name).select('*', { count: 'exact', head: true });
    if (countError) throw new Error(`relecture ${name}: ${countError.message}`);
    console.log(`  ${name.padEnd(17)} ${data.length} lue(s) → ${count} en cible`);
  }
}

/** Storage n'expose pas de listing récursif : on descend dossier par dossier. */
async function listAll(client, prefix = '') {
  const found = [];
  const { data, error } = await client.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw new Error(`listing ${prefix || '/'}: ${error.message}`);
  for (const entry of data) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Un dossier n'a pas de métadonnées ; un fichier en a toujours.
    if (entry.id === null || entry.metadata === null) found.push(...await listAll(client, path));
    else found.push(path);
  }
  return found;
}

async function copyFiles() {
  const paths = await listAll(srcFiles);
  console.log(`  ${paths.length} objet(s) dans ${BUCKET}`);

  let done = 0, skipped = 0;
  for (const path of paths) {
    const { data: blob, error } = await srcFiles.storage.from(BUCKET).download(path);
    if (error) throw new Error(`download ${path}: ${error.message}`);

    const body = Buffer.from(await blob.arrayBuffer());
    const { error: upError } = await dstFiles.storage.from(BUCKET).upload(path, body, {
      upsert: true,
      contentType: blob.type || 'application/octet-stream',
    });
    if (upError) throw new Error(`upload ${path}: ${upError.message}`);

    done++;
    if (done % 10 === 0) console.log(`    ${done}/${paths.length}`);
  }
  console.log(`  ${done} copié(s)${skipped ? `, ${skipped} ignoré(s)` : ''}`);

  const after = await listAll(dstFiles);
  console.log(`  cible : ${after.length} objet(s)`);
  if (after.length !== paths.length) throw new Error('le compte des objets ne correspond pas');
}

console.log(`Source : ${sourceUrl}`);
console.log(`Cible  : ${targetUrl}\n`);
console.log('Tables :');
await copyTables();
console.log('\nFichiers :');
await copyFiles();
console.log('\nTerminé.');
