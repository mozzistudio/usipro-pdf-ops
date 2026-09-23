import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * The durable side of the solution.
 *
 * Everything the tools learn — operator retours, the index of work done, the
 * deliverables themselves — lives in the `usipro` schema of Supabase, reached
 * with the service role. The service role bypasses RLS, and the tables carry
 * RLS with no policy, so nothing but this server can read them.
 *
 * When the keys are absent (a laptop, a first run) the stores fall back to a
 * local JSONL file. That fallback is for development only: on a host with an
 * ephemeral filesystem it loses everything at the next deploy, which is
 * precisely why this module exists.
 */

/**
 * The schema-bound client's generics differ from the default `SupabaseClient`,
 * and none of the table types are generated here — one loose alias keeps both
 * clients assignable without pretending to a typing we don't have.
 */
type Db = SupabaseClient<any, any, any>;

let cached: Db | null | undefined;

/**
 * Why the configured key cannot be used, or null when it looks usable.
 *
 * A wrong key does not fail at startup — it fails on the first write, hours
 * later, as a 401 on a retour the operator believes was saved. Two shapes are
 * caught here because both happen in practice: the placeholder line copied
 * verbatim from the instructions, and a publishable key pasted in place of the
 * service role one (which RLS would silently refuse).
 */
function keyProblem(key: string): string | null {
  if (/[<>\s]/.test(key)) return 'la ligne contient encore le texte à remplacer';
  if (key.startsWith('sb_publishable_') || key.startsWith('sb_anon_')) {
    return 'c’est une clé publiable, pas la clé service_role';
  }

  // A legacy key is a JWT whose payload names the role it grants.
  if (key.startsWith('eyJ')) {
    const payload = key.split('.')[1];
    if (!payload) return 'JWT malformé';
    try {
      const role = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).role;
      if (role && role !== 'service_role') return `cette clé porte le rôle « ${role} », pas service_role`;
    } catch {
      return 'JWT illisible';
    }
    return null;
  }

  if (key.startsWith('sb_secret_')) return null;
  return 'format de clé inattendu';
}

export function supabase(): Db | null {
  if (cached !== undefined) return cached;

  const { url, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey) {
    logger.warn(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absentes — stockage local (fichier). ' +
      'Sur un hébergement au disque éphémère, la mémoire est perdue à chaque déploiement.',
    );
    cached = null;
    return null;
  }

  const problem = keyProblem(serviceRoleKey);
  if (problem) {
    logger.error(
      { problem },
      'SUPABASE_SERVICE_ROLE_KEY inutilisable — stockage local (fichier). ' +
      'Colle la clé service_role du projet (Supabase → Project Settings → API keys).',
    );
    cached = null;
    return null;
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'usipro' },
  });
  logger.info({ url }, 'Supabase connecté (schéma usipro)');
  return cached;
}

/** Private bucket holding the deliverables; read back through signed URLs. */
export const STORAGE_BUCKET = 'usipro-files';

/**
 * Storage lives outside the `usipro` schema, so it needs a client bound to the
 * default schema — the one above would send storage calls to the wrong place.
 */
let storageCached: Db | null | undefined;

export function supabaseStorage(): Db | null {
  if (storageCached !== undefined) return storageCached;

  const { url, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey || keyProblem(serviceRoleKey)) {
    storageCached = null;
    return null;
  }

  storageCached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return storageCached;
}

/** Test seam: drop the memoised clients so a new env can take effect. */
export function __resetForTests(): void {
  cached = undefined;
  storageCached = undefined;
}
