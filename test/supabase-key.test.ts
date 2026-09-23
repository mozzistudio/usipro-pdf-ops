/**
 * The Supabase key guard.
 *
 * A wrong key does not fail at startup — it fails on the first write, as a 401
 * on a retour the operator believes was saved. Both shapes below have happened
 * for real: the placeholder line pasted verbatim, and a publishable key used in
 * place of the service role one. Either must land on the local fallback with a
 * loud log, never on a client that looks configured.
 *
 * Run: npx ts-node test/supabase-key.test.ts
 */

import { config } from '../src/config';
import { supabase, __resetForTests } from '../src/services/supabaseClient';

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

function jwtWithRole(role: string): string {
  const payload = Buffer.from(JSON.stringify({ role })).toString('base64');
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.signature`;
}

/** Swaps the configured key and reports whether a client was built. */
function connectsWith(key: string): boolean {
  const mutable = config as unknown as { supabase: { url: string; serviceRoleKey: string } };
  mutable.supabase.url = 'https://example.supabase.co';
  mutable.supabase.serviceRoleKey = key;
  __resetForTests();
  return supabase() !== null;
}

const cases: Array<[string, string, boolean]> = [
  ['le placeholder copié tel quel', '<colle la clé service_role>', false],
  ['une clé publiable', 'sb_publishable_F3zK9i46JVrnZf1tJEg50w', false],
  ['un JWT anon', jwtWithRole('anon'), false],
  ['une clé vide', '', false],
  ['du texte quelconque', 'à remplir plus tard', false],
  ['un JWT service_role', jwtWithRole('service_role'), true],
  ['une clé secrète moderne', 'sb_secret_abcdef123456', true],
];

console.log('\n─── Clé Supabase ───────────────────────────────────────────');

for (const [label, key, shouldConnect] of cases) {
  const connected = connectsWith(key);
  assert(
    connected === shouldConnect,
    `${label} → ${shouldConnect ? 'Supabase' : 'repli local'}${connected === shouldConnect ? '' : ' (obtenu le contraire)'}`,
  );
}

__resetForTests();
console.log(`\n─── ${passed} passés, ${failed} échoués ───\n`);
