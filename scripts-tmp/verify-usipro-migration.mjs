/** Contrôle d'arrivée : chaque objet du bucket existe en cible, à la même taille. */
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const BUCKET = 'usipro-files';
const mk = (url, key) => createClient(url, key, { auth: { persistSession: false } });
const src = mk(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const dst = mk(process.env.TARGET_URL, process.env.TARGET_KEY);

async function sizes(client, prefix = '', out = new Map()) {
  const { data, error } = await client.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw new Error(`${prefix || '/'}: ${error.message}`);
  for (const e of data) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.id === null || e.metadata === null) await sizes(client, path, out);
    else out.set(path, e.metadata?.size ?? -1);
  }
  return out;
}

const a = await sizes(src), b = await sizes(dst);
const problems = [];
for (const [path, size] of a) {
  if (!b.has(path)) problems.push(`absent en cible : ${path}`);
  else if (b.get(path) !== size) problems.push(`taille différente : ${path} (${size} → ${b.get(path)})`);
}
for (const path of b.keys()) if (!a.has(path)) problems.push(`en trop en cible : ${path}`);

const total = [...a.values()].reduce((s, n) => s + n, 0);
console.log(`source ${a.size} objets, ${(total / 1048576).toFixed(1)} Mo`);
console.log(`cible  ${b.size} objets, ${([...b.values()].reduce((s, n) => s + n, 0) / 1048576).toFixed(1)} Mo`);
if (problems.length) { console.log('\n' + problems.join('\n')); process.exit(1); }
console.log('\nTous les objets correspondent, chemin et taille.');
