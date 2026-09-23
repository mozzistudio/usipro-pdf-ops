import crypto from 'crypto';
import { logger } from '../utils/logger';
import { supabase } from './supabaseClient';
import {
  MatchKind,
  StepFingerprint,
  compareFingerprints,
  fingerprintStep,
} from './stepFingerprint';

/**
 * Le référentiel article — la mémoire qui rend un rattachement possible.
 *
 * Règle qui traverse tout ce fichier, reprise du catalogue des cas produits :
 * **l'app ne fusionne jamais deux références toute seule**. Elle rattache une
 * pièce à son propre article (client + référence), enregistre ce qu'elle a vu,
 * et présente les candidats avec leurs preuves. Deux clients peuvent
 * légitimement vouloir deux articles distincts pour la même géométrie ; c'est
 * une décision humaine, pas un score.
 *
 * Aucun prix n'est calculé ici. Une pièce déjà passée donne « déjà vue le
 * JJ/MM sur l'OF X », ce qui est déjà la moitié de la réponse attendue.
 */

export interface ArticleRecord {
  id: string;
  client: string;
  reference: string;
  designation?: string;
  createdAt: string;
}

export interface ArticleVersionRecord {
  id: string;
  articleId: string;
  createdAt: string;
  indice?: string;
  stepDataSha256?: string;
  pointCount?: number;
  bboxMm?: number[];
  entityCounts?: Record<string, number>;
  planSha256?: string;
  sourceOf?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Un candidat de rattachement, avec de quoi trancher. */
export interface AttachmentCandidate {
  kind: MatchKind;
  score: number;
  reasons: string[];
  /** Vrai quand le candidat appartient déjà à l'article de la demande. */
  sameArticle: boolean;
  article: { id: string; client: string; reference: string; designation?: string };
  version: { id: string; indice?: string; sourceOf?: string; lastSeenAt: string };
}

/**
 * Comment l'app se comporte face à ce qu'elle a trouvé — les modes du
 * catalogue. « auto » ne veut jamais dire « un prix a été décidé » : ici, cela
 * signifie seulement que le rattachement ne demande pas d'arbitrage.
 */
export type AttachmentMode = 'auto' | 'proposition';

export interface Attachment {
  mode: AttachmentMode;
  /** Phrase prête à afficher : ce que l'opérateur lit en premier. */
  summary: string;
  article: ArticleRecord;
  version: ArticleVersionRecord;
  /** Les meilleurs candidats, le plus probant d'abord. */
  candidates: AttachmentCandidate[];
  /** Passages précédents de cet article, hors version courante. */
  history: Array<{ of: string | null; seenAt: string; indice?: string }>;
}

/** Candidats rapprochés avant comparaison fine. Large sans être coûteux. */
const CANDIDATE_LIMIT = 200;
/** Écart toléré sur le nombre de points pour un pré-filtrage d'invariants. */
const POINT_COUNT_WINDOW = 0.02;

function db() {
  const client = supabase();
  if (!client) {
    throw new Error(
      'Référentiel article indisponible : Supabase non configuré. ' +
      'Un rattachement sans mémoire durable n’aurait aucun sens.',
    );
  }
  return client;
}

// ── Écriture ─────────────────────────────────────────────────────

async function findOrCreateArticle(
  client: string,
  reference: string,
  designation?: string,
): Promise<ArticleRecord> {
  const existing = await db()
    .from('articles')
    .select('*')
    .eq('client', client)
    .eq('reference', reference)
    .maybeSingle();

  if (existing.error) throw new Error(`Lecture article impossible: ${existing.error.message}`);

  if (existing.data) {
    const row = existing.data as any;
    // Une désignation arrive parfois après coup (cartouche lu au 2e passage).
    if (designation && !row.designation) {
      await db().from('articles').update({ designation, updated_at: new Date().toISOString() }).eq('id', row.id);
      row.designation = designation;
    }
    return toArticle(row);
  }

  const insert = await db()
    .from('articles')
    .insert({ id: crypto.randomUUID(), client, reference, designation: designation ?? null })
    .select()
    .single();

  if (insert.error) throw new Error(`Création article impossible: ${insert.error.message}`);
  logger.info({ client, reference }, 'Nouvel article au référentiel');
  return toArticle(insert.data);
}

// ── Lecture des candidats ────────────────────────────────────────

/**
 * Rapproche d'abord par index — hash exact, puis fenêtre sur le nombre de
 * points — avant de comparer finement. Sans ce pré-filtrage, chaque pièce
 * reçue relirait tout le référentiel.
 */
async function findCandidateVersions(fp: StepFingerprint): Promise<any[]> {
  const rows = new Map<string, any>();

  if (fp.dataSha256) {
    const exact = await db()
      .from('article_versions')
      .select('*, articles(*)')
      .eq('step_data_sha256', fp.dataSha256)
      .limit(CANDIDATE_LIMIT);
    if (exact.error) throw new Error(`Recherche par hash impossible: ${exact.error.message}`);
    for (const row of exact.data ?? []) rows.set((row as any).id, row);
  }

  if (fp.pointCount > 0) {
    const slack = Math.max(1, Math.round(fp.pointCount * POINT_COUNT_WINDOW));
    const near = await db()
      .from('article_versions')
      .select('*, articles(*)')
      .gte('point_count', fp.pointCount - slack)
      .lte('point_count', fp.pointCount + slack)
      .limit(CANDIDATE_LIMIT);
    if (near.error) throw new Error(`Recherche par invariants impossible: ${near.error.message}`);
    for (const row of near.data ?? []) rows.set((row as any).id, row);
  }

  return [...rows.values()];
}

// ── Le geste principal ───────────────────────────────────────────

export interface AttachInput {
  client: string;
  /** Référence telle que le client l'écrit. */
  reference: string;
  indice?: string;
  /** OF ou consultation qui amène cette pièce. */
  sourceOf: string;
  stepBytes?: Buffer;
  planSha256?: string;
  designation?: string;
  cartouche?: Record<string, unknown>;
}

/**
 * Rattache une pièce reçue au référentiel et dit ce qu'elle a déjà vécu.
 *
 * L'article est toujours celui de la référence du client. Une géométrie
 * identique trouvée sous une AUTRE référence ne déclenche pas de fusion : elle
 * remonte en proposition, preuves à l'appui (ID-02).
 */
export async function attachPart(input: AttachInput): Promise<Attachment> {
  const fp: StepFingerprint = input.stepBytes
    ? fingerprintStep(input.stepBytes)
    : { dataSha256: null, entityCounts: {}, pointCount: 0, bboxMm: null };

  const article = await findOrCreateArticle(input.client, input.reference, input.designation);

  const rawCandidates = await findCandidateVersions(fp);

  const candidates: AttachmentCandidate[] = [];
  for (const row of rawCandidates) {
    const other: StepFingerprint = {
      dataSha256: row.step_data_sha256 ?? null,
      entityCounts: (row.entity_counts ?? {}) as Record<string, number>,
      pointCount: row.point_count ?? 0,
      bboxMm: normaliseBbox(row.bbox_mm),
    };
    const match = compareFingerprints(fp, other);
    if (match.kind === 'different') continue;

    candidates.push({
      kind: match.kind,
      score: match.score,
      reasons: match.reasons,
      sameArticle: row.article_id === article.id,
      article: {
        id: row.articles?.id ?? row.article_id,
        client: row.articles?.client ?? '—',
        reference: row.articles?.reference ?? '—',
        designation: row.articles?.designation ?? undefined,
      },
      version: {
        id: row.id,
        indice: row.indice ?? undefined,
        sourceOf: row.source_of ?? undefined,
        lastSeenAt: row.last_seen_at,
      },
    });
  }

  candidates.sort((a, b) => b.score - a.score || (a.sameArticle === b.sameArticle ? 0 : a.sameArticle ? -1 : 1));

  const version = await recordVersion(article.id, fp, input, candidates);
  const history = await readHistory(article.id, version.id);

  const { mode, summary } = decide(candidates, history, input);

  logger.info(
    {
      client: input.client,
      reference: input.reference,
      of: input.sourceOf,
      mode,
      candidateCount: candidates.length,
      best: candidates[0]?.kind,
    },
    'Rattachement article',
  );

  return { mode, summary, article, version, candidates: candidates.slice(0, 5), history };
}

/**
 * Enregistre la version, ou rafraîchit celle qui porte déjà cette géométrie
 * pour cet article : une pièce qui repasse à l'identique ne doit pas remplir le
 * référentiel de doublons.
 */
async function recordVersion(
  articleId: string,
  fp: StepFingerprint,
  input: AttachInput,
  candidates: AttachmentCandidate[],
): Promise<ArticleVersionRecord> {
  const twin = candidates.find(
    c => c.sameArticle && c.kind === 'identique' && c.version.indice === input.indice,
  );

  if (twin) {
    const updated = await db()
      .from('article_versions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', twin.version.id)
      .select()
      .single();
    if (updated.error) throw new Error(`Mise à jour version impossible: ${updated.error.message}`);
    return toVersion(updated.data);
  }

  const insert = await db()
    .from('article_versions')
    .insert({
      id: crypto.randomUUID(),
      article_id: articleId,
      indice: input.indice ?? null,
      step_data_sha256: fp.dataSha256,
      entity_counts: fp.entityCounts,
      bbox_mm: fp.bboxMm,
      point_count: fp.pointCount,
      plan_sha256: input.planSha256 ?? null,
      cartouche: input.cartouche ?? null,
      source_of: input.sourceOf,
    })
    .select()
    .single();

  if (insert.error) throw new Error(`Création version impossible: ${insert.error.message}`);
  return toVersion(insert.data);
}

/** Les passages précédents de l'article, la version courante exclue. */
async function readHistory(
  articleId: string,
  currentVersionId: string,
): Promise<Array<{ of: string | null; seenAt: string; indice?: string }>> {
  const { data, error } = await db()
    .from('article_versions')
    .select('id, source_of, indice, last_seen_at')
    .eq('article_id', articleId)
    .order('last_seen_at', { ascending: false })
    .limit(20);

  if (error) throw new Error(`Lecture historique impossible: ${error.message}`);

  return (data ?? [])
    .filter((row: any) => row.id !== currentVersionId)
    .map((row: any) => ({
      of: row.source_of ?? null,
      seenAt: row.last_seen_at,
      indice: row.indice ?? undefined,
    }));
}

/**
 * Le mode et la phrase affichée.
 *
 * Une géométrie identique sous une autre référence ne conclut pas : elle pose
 * une question. Une pièce sans aucune correspondance conclut, mais en le
 * disant — « aucune référence historique » est une information commerciale,
 * pas un détail technique (ID-09).
 */
function decide(
  candidates: AttachmentCandidate[],
  history: Array<{ of: string | null; seenAt: string }>,
  input: AttachInput,
): { mode: AttachmentMode; summary: string } {
  const foreign = candidates.find(c => !c.sameArticle && (c.kind === 'identique' || c.kind === 'reexport'));
  if (foreign) {
    return {
      mode: 'proposition',
      summary:
        `Même géométrie que ${foreign.article.reference} (${foreign.article.client}) — ` +
        'rattacher les deux références au même article ?',
    };
  }

  const neighbour = candidates.find(c => c.kind === 'voisin');
  const own = candidates.find(c => c.sameArticle);

  if (own && (own.kind === 'identique' || own.kind === 'reexport')) {
    const last = history[0];
    const when = last ? formatDate(last.seenAt) : formatDate(own.version.lastSeenAt);
    const where = last?.of ? `, OF ${last.of}` : '';
    const how = own.kind === 'reexport' ? ' (fichier ré-exporté, pièce inchangée)' : '';
    return { mode: 'auto', summary: `Déjà vue le ${when}${where}${how}.` };
  }

  if (neighbour) {
    return {
      mode: 'proposition',
      summary:
        `Proche de ${neighbour.article.reference} : ${neighbour.reasons.join(', ')} — ` +
        'même famille ?',
    };
  }

  if (history.length > 0) {
    const last = history[0];
    return {
      mode: 'proposition',
      summary:
        `Référence déjà connue (vue le ${formatDate(last.seenAt)}${last.of ? `, OF ${last.of}` : ''}) ` +
        'mais géométrie différente — indice à confirmer.',
    };
  }

  if (!input.stepBytes) {
    return {
      mode: 'proposition',
      summary: 'Aucun modèle 3D reçu : rattachement impossible sur la géométrie seule.',
    };
  }

  return { mode: 'auto', summary: 'Aucune référence historique — première fois que cette pièce passe.' };
}

// ── Conversions ──────────────────────────────────────────────────

function toArticle(row: any): ArticleRecord {
  return {
    id: row.id,
    client: row.client,
    reference: row.reference,
    designation: row.designation ?? undefined,
    createdAt: row.created_at,
  };
}

function toVersion(row: any): ArticleVersionRecord {
  return {
    id: row.id,
    articleId: row.article_id,
    createdAt: row.created_at,
    indice: row.indice ?? undefined,
    stepDataSha256: row.step_data_sha256 ?? undefined,
    pointCount: row.point_count ?? undefined,
    bboxMm: normaliseBbox(row.bbox_mm) ?? undefined,
    entityCounts: (row.entity_counts ?? undefined) as Record<string, number> | undefined,
    planSha256: row.plan_sha256 ?? undefined,
    sourceOf: row.source_of ?? undefined,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Postgres rend un numeric[] en chaînes ; sans ça, toute comparaison échoue. */
function normaliseBbox(raw: unknown): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const nums = raw.map(v => Number(v));
  return nums.every(n => Number.isFinite(n)) ? (nums as [number, number, number]) : null;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── Lecture pour l'interface ─────────────────────────────────────

/** Les articles du référentiel, les plus récemment vus d'abord. */
export async function listArticles(filter: { client?: string; limit?: number } = {}) {
  let query = db()
    .from('articles')
    .select('*, article_versions(id, indice, source_of, last_seen_at, point_count)')
    .order('updated_at', { ascending: false });
  if (filter.client) query = query.eq('client', filter.client);

  const { data, error } = await query.limit(filter.limit ?? 100);
  if (error) throw new Error(`Lecture du référentiel impossible: ${error.message}`);
  return data ?? [];
}
