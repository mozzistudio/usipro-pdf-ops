import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { supabase, supabaseStorage, STORAGE_BUCKET } from './supabaseClient';
import { ChiffrageLine, ChiffrageRequest } from '../types';
import {
  DEFAULT_SETTINGS,
  MaterialRate,
  PricingSettings,
  computeLinePrice,
} from './costEngine';

/**
 * The index of work actually done, and the deliverables themselves.
 *
 * Sessions live 30 minutes in memory and the files went to Dropbox, so until
 * now nothing in the solution could answer "what did we run last week, for
 * whom, and how did it end". One row per job — written when the job first
 * produces something an operator can look at, written again when it is
 * delivered — plus the produced files kept in our own storage, is what makes
 * the Fichiers section of the home real rather than a mockup.
 *
 * Supabase (`usipro.works`, `usipro.work_files`, bucket `usipro-files`), with
 * a JSONL fallback for a laptop without keys. Files are never stored in the
 * fallback: without Supabase, only the Dropbox link survives.
 */

export type WorkTool = 'edition' | 'chiffrage';

/** Where the job came in from — a form submission or a mail to chiffrage@. */
export type WorkSource = 'form' | 'email';

export type WorkStatus = 'a_valider' | 'livre';

export type WorkFileKind =
  | 'plan_anonymise'
  | 'plan_original'
  | 'devis_pdf'
  | 'devis_docx'
  | 'zip'
  /** Ce que le client a joint à sa demande — tableur de quantités, plan, STEP. */
  | 'piece_jointe';

export interface WorkRecord {
  /** `${tool}:${ref}` — a re-run of the same OF updates its row instead of adding one. */
  id: string;
  createdAt: string;
  updatedAt: string;
  tool: WorkTool;
  source: WorkSource;
  /** Resolved OF number, or the reference of the chiffrage request. */
  ref: string;
  status: WorkStatus;
  client: string;
  /** Free tag, set by hand — nothing in an OF says which project it serves. */
  project?: string;
  partIds: string[];
  /** Plans actually anonymized (parts whose folder held no plan are not counted). */
  planCount: number;
  missingParts: string[];
  dropboxLink?: string;
  /** Ce que l'extraction a compris de la demande, pour une demande de chiffrage. */
  summary?: string;
  /** Vrai quand le contenu de la demande est dans les pièces jointes. */
  detailsInAttachments?: boolean;
  /** Liens de partage à ouvrir à la main (WeTransfer, Drive…). */
  links?: string[];
}

export interface WorkFileRecord {
  id: string;
  workId: string;
  createdAt: string;
  kind: WorkFileKind;
  partId?: string;
  fileName: string;
  storagePath: string;
  byteSize: number;
}

export interface WorkStartInput {
  tool: WorkTool;
  source: WorkSource;
  ref: string;
  client: string;
  partIds: string[];
  planCount: number;
  missingParts?: string[];
}

/** Signed URLs are short-lived: the bucket is private and stays private. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export function workId(tool: WorkTool, ref: string): string {
  return `${tool}:${ref}`;
}

// ── Supabase row mapping ─────────────────────────────────────────

interface WorkRow {
  id: string;
  created_at: string;
  updated_at: string;
  tool: WorkTool;
  source: WorkSource;
  ref: string;
  status: WorkStatus;
  client: string;
  project: string | null;
  part_ids: string[];
  plan_count: number;
  missing_parts: string[];
  dropbox_link: string | null;
  summary: string | null;
  details_in_attachments: boolean | null;
  links: string[] | null;
}

function fromRow(row: WorkRow): WorkRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tool: row.tool,
    source: row.source,
    ref: row.ref,
    status: row.status,
    client: row.client,
    project: row.project ?? undefined,
    partIds: row.part_ids ?? [],
    planCount: row.plan_count ?? 0,
    missingParts: row.missing_parts ?? [],
    dropboxLink: row.dropbox_link ?? undefined,
    summary: row.summary ?? undefined,
    detailsInAttachments: row.details_in_attachments ?? undefined,
    links: row.links ?? [],
  };
}

function toRow(rec: WorkRecord): WorkRow {
  return {
    id: rec.id,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    tool: rec.tool,
    source: rec.source,
    ref: rec.ref,
    status: rec.status,
    client: rec.client,
    project: rec.project ?? null,
    part_ids: rec.partIds,
    plan_count: rec.planCount,
    missing_parts: rec.missingParts,
    dropbox_link: rec.dropboxLink ?? null,
    summary: rec.summary ?? null,
    details_in_attachments: rec.detailsInAttachments ?? false,
    links: rec.links ?? [],
  };
}

// ── Local fallback storage ───────────────────────────────────────

const local = new Map<string, WorkRecord>();
let loaded = false;
let persistence = true;

function loadLocal(): void {
  if (loaded) return;
  loaded = true;

  let raw: string;
  try {
    raw = fs.readFileSync(config.works.path, 'utf8');
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err: err.message }, 'Index des travaux local illisible — démarrage à vide');
    }
    return;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as WorkRecord;
      if (rec?.id) local.set(rec.id, rec);
    } catch {
      // A broken line is one lost job, not a reason to lose the file.
    }
  }
}

function persistLocal(rec: WorkRecord): void {
  local.set(rec.id, rec);
  if (!persistence) return;
  try {
    fs.mkdirSync(path.dirname(config.works.path), { recursive: true });
    fs.appendFileSync(config.works.path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err: any) {
    persistence = false;
    logger.error({ err: err.message }, 'Travail non indexé — mémoire process uniquement');
  }
}

// ── Writing ──────────────────────────────────────────────────────

async function readExisting(id: string): Promise<WorkRecord | null> {
  const db = supabase();
  if (db) {
    const { data, error } = await db.from('works').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`Lecture du travail impossible: ${error.message}`);
    return data ? fromRow(data as WorkRow) : null;
  }
  loadLocal();
  return local.get(id) ?? null;
}

async function write(rec: WorkRecord): Promise<WorkRecord> {
  const db = supabase();
  if (db) {
    const { error } = await db.from('works').upsert(toRow(rec), { onConflict: 'id' });
    if (error) throw new Error(`Travail non indexé: ${error.message}`);
    return rec;
  }
  loadLocal();
  persistLocal(rec);
  return rec;
}

/**
 * Files a job as soon as it has produced something an operator can look at.
 * Recording it here rather than at delivery means a lot abandoned mid-
 * validation still shows on the home instead of vanishing.
 */
export async function recordWorkStarted(input: WorkStartInput): Promise<WorkRecord> {
  const now = new Date().toISOString();
  const id = workId(input.tool, input.ref);
  const existing = await readExisting(id);

  const rec: WorkRecord = {
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    tool: input.tool,
    source: input.source,
    ref: input.ref,
    // A re-run of a delivered OF reopens it: it is being worked on again.
    status: 'a_valider',
    client: input.client,
    project: existing?.project,
    partIds: input.partIds,
    planCount: input.planCount,
    missingParts: input.missingParts ?? [],
    dropboxLink: existing?.dropboxLink,
  };

  await write(rec);
  logger.info({ id, planCount: rec.planCount, source: rec.source }, 'Travail indexé');
  return rec;
}

/**
 * Closes the job. An unknown ref is still recorded — losing the trace of a
 * delivered OF because the process restarted mid-flight would be worse than a
 * row with a few empty fields.
 */
export async function recordWorkDelivered(
  tool: WorkTool,
  ref: string,
  update: { dropboxLink?: string; planCount?: number; missingParts?: string[]; client?: string },
): Promise<WorkRecord> {
  const now = new Date().toISOString();
  const id = workId(tool, ref);
  const existing = await readExisting(id);

  const rec: WorkRecord = {
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    tool,
    source: existing?.source ?? 'form',
    ref,
    status: 'livre',
    client: update.client ?? existing?.client ?? '—',
    project: existing?.project,
    partIds: existing?.partIds ?? [],
    planCount: update.planCount ?? existing?.planCount ?? 0,
    missingParts: update.missingParts ?? existing?.missingParts ?? [],
    dropboxLink: update.dropboxLink ?? existing?.dropboxLink,
  };

  await write(rec);
  logger.info({ id, dropboxLink: rec.dropboxLink }, 'Travail livré');
  return rec;
}

/**
 * Change le statut d'un travail.
 *
 * C'est le geste de l'opérateur: une demande lue et traitée passe à « livré ».
 * Rien d'automatique ne fait cette transition pour une demande de chiffrage —
 * tant qu'aucun moteur de prix n'existe, c'est un humain qui décide qu'elle
 * est close.
 */
export async function setWorkStatus(id: string, status: WorkStatus): Promise<WorkRecord | null> {
  const existing = await readExisting(id);
  if (!existing) return null;

  const rec: WorkRecord = { ...existing, status, updatedAt: new Date().toISOString() };
  await write(rec);
  logger.info({ id, status }, 'Statut du travail modifié');
  return rec;
}

/** Sets the project tag on a job — the one tag no pipeline can infer. */
export async function setWorkProject(id: string, project: string | null): Promise<WorkRecord | null> {
  const existing = await readExisting(id);
  if (!existing) return null;

  const rec: WorkRecord = {
    ...existing,
    project: project?.trim() ? project.trim().slice(0, 60) : undefined,
    updatedAt: new Date().toISOString(),
  };
  return write(rec);
}

// ── Reading ──────────────────────────────────────────────────────

export interface WorkFilter {
  tool?: WorkTool;
  client?: string;
  project?: string;
  limit?: number;
}

/** Newest activity first. */
export async function listWorks(filter: WorkFilter = {}): Promise<WorkRecord[]> {
  const db = supabase();

  if (db) {
    let query = db.from('works').select('*').order('updated_at', { ascending: false });
    if (filter.tool) query = query.eq('tool', filter.tool);
    if (filter.client) query = query.eq('client', filter.client);
    if (filter.project) query = query.eq('project', filter.project);
    const { data, error } = await query.limit(filter.limit ?? 100);
    if (error) throw new Error(`Lecture des travaux impossible: ${error.message}`);
    return (data as WorkRow[]).map(fromRow);
  }

  loadLocal();
  return [...local.values()]
    .filter(w => !filter.tool || w.tool === filter.tool)
    .filter(w => !filter.client || w.client === filter.client)
    .filter(w => !filter.project || w.project === filter.project)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, filter.limit ?? 100);
}

/** Counts per tag value, for the filter chips on the home. */
export async function workFacets(): Promise<{
  clients: Record<string, number>;
  projects: Record<string, number>;
}> {
  const all = await listWorks({ limit: 1000 });
  const clients: Record<string, number> = {};
  const projects: Record<string, number> = {};
  for (const w of all) {
    clients[w.client] = (clients[w.client] ?? 0) + 1;
    if (w.project) projects[w.project] = (projects[w.project] ?? 0) + 1;
  }
  return { clients, projects };
}

// ── Demandes de chiffrage ────────────────────────────────────────

/**
 * Enregistre une demande de chiffrage reçue par mail.
 *
 * Pas d'OF : le travail est indexé sur la référence de la demande. Un même
 * mail rejoué retombe donc sur la même ligne au lieu d'en créer une seconde.
 *
 * Une demande dont tout le contenu est en pièce jointe est enregistrée quand
 * même, avec zéro ligne et le drapeau qui le dit. Perdre la demande parce
 * qu'on ne sait pas encore lire un Excel serait pire que l'afficher incomplète.
 */
export async function recordChiffrageRequest(
  request: ChiffrageRequest,
  source: WorkSource = 'email',
): Promise<WorkRecord> {
  const now = new Date().toISOString();
  const id = workId('chiffrage', request.reference);
  const existing = await readExisting(id);

  const rec: WorkRecord = {
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    tool: 'chiffrage',
    source,
    ref: request.reference,
    status: 'a_valider',
    client: request.client || '—',
    project: existing?.project,
    partIds: request.lines.map(l => l.reference).filter(Boolean),
    planCount: 0,
    missingParts: [],
    dropboxLink: existing?.dropboxLink,
    summary: request.summary,
    detailsInAttachments: request.detailsInAttachments,
    links: request.links ?? [],
  };

  await write(rec);
  await replaceRequestLines(id, request.lines);

  logger.info(
    {
      id,
      client: rec.client,
      lineCount: request.lines.length,
      detailsInAttachments: request.detailsInAttachments,
    },
    'Demande de chiffrage enregistrée',
  );
  return rec;
}

/**
 * Remplace les lignes d'une demande. Un rejeu du même mail doit reposer les
 * mêmes lignes, pas les empiler.
 */
async function replaceRequestLines(id: string, lines: ChiffrageLine[]): Promise<void> {
  const db = supabase();
  if (!db) return;

  const { error: delErr } = await db.from('request_lines').delete().eq('work_id', id);
  if (delErr) throw new Error(`Nettoyage des lignes impossible: ${delErr.message}`);
  if (lines.length === 0) return;

  const rows = lines.map((line, index) => ({
    id: crypto.randomUUID(),
    work_id: id,
    position: index,
    reference: line.reference || null,
    designation: line.designation || null,
    material: line.material || null,
    quantity: line.quantity || null,
    comment: line.comment || null,
  }));

  const { error } = await db.from('request_lines').insert(rows);
  if (error) throw new Error(`Lignes de la demande non enregistrées: ${error.message}`);
}

// ── Moteur de coût : paramètres et tarifs ────────────────────────

/**
 * Les paramètres du moteur. Sans base, on rend les valeurs par défaut: un prix
 * doit pouvoir s'afficher même sur un poste de développement.
 */
export async function getPricingSettings(): Promise<PricingSettings> {
  const db = supabase();
  if (!db) return DEFAULT_SETTINGS;

  const { data, error } = await db.from('pricing_settings').select('*').eq('id', 'default').maybeSingle();
  if (error) throw new Error(`Lecture des paramètres de prix impossible: ${error.message}`);
  if (!data) return DEFAULT_SETTINGS;

  return {
    currency: data.currency ?? 'EUR',
    hourlyRate: Number(data.hourly_rate),
    setupMinutes: Number(data.setup_minutes),
    minutesPerDm3: Number(data.minutes_per_dm3),
    removalRatio: Number(data.removal_ratio),
    learningCurve: Number(data.learning_curve),
    marginPct: Number(data.margin_pct),
    handlingMinutesPerPart: Number(data.handling_minutes_per_part),
  };
}

export async function setPricingSettings(patch: Partial<PricingSettings>): Promise<PricingSettings> {
  const db = supabase();
  if (!db) throw new Error('Paramètres de prix indisponibles : Supabase non configuré');

  const row: Record<string, unknown> = { id: 'default', updated_at: new Date().toISOString() };
  const map: Array<[keyof PricingSettings, string]> = [
    ['currency', 'currency'],
    ['hourlyRate', 'hourly_rate'],
    ['setupMinutes', 'setup_minutes'],
    ['minutesPerDm3', 'minutes_per_dm3'],
    ['removalRatio', 'removal_ratio'],
    ['learningCurve', 'learning_curve'],
    ['marginPct', 'margin_pct'],
    ['handlingMinutesPerPart', 'handling_minutes_per_part'],
  ];
  for (const [key, column] of map) {
    if (patch[key] !== undefined) row[column] = patch[key];
  }

  const { error } = await db.from('pricing_settings').upsert(row, { onConflict: 'id' });
  if (error) throw new Error(`Paramètres de prix non enregistrés: ${error.message}`);

  logger.info({ patch }, 'Paramètres du moteur de coût modifiés');
  return getPricingSettings();
}

export async function listMaterialRates(): Promise<MaterialRate[]> {
  const db = supabase();
  if (!db) return [];

  const { data, error } = await db.from('material_rates').select('*').order('label');
  if (error) throw new Error(`Lecture des tarifs matière impossible: ${error.message}`);

  return (data ?? []).map((row: any) => ({
    id: row.id,
    label: row.label,
    aliases: String(row.aliases || '').split(',').map(a => a.trim()).filter(Boolean),
    pricePerKg: Number(row.price_per_kg),
    density: Number(row.density),
  }));
}

export async function setMaterialRate(
  id: string,
  patch: { pricePerKg?: number; density?: number; label?: string; aliases?: string[] },
): Promise<MaterialRate[]> {
  const db = supabase();
  if (!db) throw new Error('Tarifs matière indisponibles : Supabase non configuré');

  const row: Record<string, unknown> = { id, updated_at: new Date().toISOString() };
  if (patch.pricePerKg !== undefined) row.price_per_kg = patch.pricePerKg;
  if (patch.density !== undefined) row.density = patch.density;
  if (patch.label !== undefined) row.label = patch.label;
  if (patch.aliases !== undefined) row.aliases = patch.aliases.join(',');

  // Une nuance ajoutée à la volée doit porter un libellé: sans lui, l'opérateur
  // verrait une ligne anonyme dans son tarif.
  if (patch.label === undefined) {
    const existing = await db.from('material_rates').select('id').eq('id', id).maybeSingle();
    if (!existing.data) throw new Error(`Nuance inconnue: ${id} — donner un libellé pour la créer`);
  }

  const { error } = await db.from('material_rates').upsert(row, { onConflict: 'id' });
  if (error) throw new Error(`Tarif matière non enregistré: ${error.message}`);

  logger.info({ id, patch }, 'Tarif matière modifié');
  return listMaterialRates();
}

/**
 * Calcule — ou recalcule — le prix des lignes d'une demande, et le fige.
 *
 * Figé, parce qu'un prix doit être rejouable: on garde les postes et leurs
 * bases, pas seulement le total. Un changement de paramètres ne réécrit donc
 * pas le passé tout seul; il faut relancer le calcul, et c'est voulu.
 */
export async function priceRequest(id: string): Promise<ChiffrageLine[]> {
  const db = supabase();
  if (!db) return [];

  const [settings, rates] = await Promise.all([getPricingSettings(), listMaterialRates()]);

  // Un prix imposé par client existe parfois: accord cadre, tarif négocié. Il
  // gagne sur le calcul, mais jamais en silence — le prix calculé reste au
  // bordereau, et l'écart est nommé. C'est ce qui permet de répondre « pourquoi
  // ce n'est pas le prix de la dernière fois » sans enquête.
  const work = await readExisting(id);
  const imposed = work ? (await getClientPricing(work.client))?.defaultUnitPrice ?? null : null;

  const { data, error } = await db
    .from('request_lines')
    .select('*')
    .eq('work_id', id)
    .order('position', { ascending: true });
  if (error) throw new Error(`Lecture des lignes impossible: ${error.message}`);

  const now = new Date().toISOString();
  const out: ChiffrageLine[] = [];

  for (const row of (data ?? []) as any[]) {
    // Une ligne déjà tranchée par un humain n'est pas réécrite par le moteur.
    if (row.status === 'forcee' || row.status === 'manuelle' || row.status === 'rejetee') {
      out.push(fromLineRow(row));
      continue;
    }

    const line: ChiffrageLine = {
      reference: row.reference ?? '',
      designation: row.designation ?? '',
      material: row.material ?? '',
      quantity: row.quantity ?? '',
      comment: row.comment ?? '',
    };

    const price = computeLinePrice(line, settings, rates);
    let unitPrice = price.unitPrice;
    let totalPrice = price.totalPrice;
    const items = [...price.items];
    const assumptions = [...price.assumptions];

    if (imposed !== null) {
      const delta = Math.round((imposed - price.unitPrice) * 100) / 100;
      items.push({
        label: 'Prix imposé client',
        amount: delta,
        basis:
          `tarif ${imposed} €/pièce fixé pour ce client — écart de ${delta >= 0 ? '+' : ''}${delta} € ` +
          `sur le prix calculé (${price.unitPrice} €)`,
      });
      assumptions.push(`prix imposé par le tarif client, le calcul est conservé au bordereau`);
      unitPrice = imposed;
      totalPrice = Math.round(imposed * price.quantity * 100) / 100;
    }

    const breakdown = { items, assumptions, quantity: price.quantity };

    // Le niveau d'alerte suit ce qui manque, pas l'humeur du moteur.
    // Rouge: la matière ET l'encombrement manquent — le prix ne repose sur rien.
    // Jaune: une hypothèse a été nécessaire. Vert: la demande se suffit.
    const alerts = assumptions.slice();
    const severes = assumptions.filter(a => a.includes('encombrement') || a.includes('matière'));
    const alertLevel = severes.length >= 2 ? 'rouge' : assumptions.length > 0 ? 'jaune' : 'vert';

    const { error: upErr } = await db
      .from('request_lines')
      .update({
        unit_price: unitPrice,
        total_price: totalPrice,
        price_breakdown: breakdown,
        price_computed_at: now,
        alert_level: alertLevel,
        alerts,
      })
      .eq('id', row.id);
    if (upErr) throw new Error(`Prix non enregistré: ${upErr.message}`);

    out.push({
      ...line,
      id: row.id,
      unitPrice,
      totalPrice,
      priceBreakdown: breakdown,
      status: row.status ?? 'a_traiter',
      alertLevel,
      alerts,
    });
  }

  logger.info({ id, lines: out.length }, 'Demande chiffrée');
  return out;
}

function fromLineRow(row: any): ChiffrageLine {
  return {
    id: row.id,
    reference: row.reference ?? '',
    designation: row.designation ?? '',
    material: row.material ?? '',
    quantity: row.quantity ?? '',
    comment: row.comment ?? '',
    unitPrice: row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
    totalPrice: row.total_price === null || row.total_price === undefined ? null : Number(row.total_price),
    priceBreakdown: row.price_breakdown ?? null,
    status: row.status ?? 'a_traiter',
    forcedPrice: row.forced_price === null || row.forced_price === undefined ? null : Number(row.forced_price),
    reviewNote: row.review_note ?? null,
    alertLevel: row.alert_level ?? 'vert',
    alerts: row.alerts ?? [],
  };
}

/**
 * La décision du technicien sur une ligne.
 *
 * Quatre issues, volontairement distinctes : valider le prix proposé, l'imposer
 * (le moteur s'est trompé, le calcul reste au bordereau), demander un recalcul
 * avec une consigne, ou sortir la ligne du chiffrage automatique. Une ligne
 * « traitement manuel » part sans prix et le dit — c'est plus honnête qu'un
 * chiffre posé pour ne pas laisser de case vide.
 */
export async function reviewLine(
  lineId: string,
  action: 'valider' | 'forcer' | 'recalculer' | 'manuel' | 'rejeter',
  options: { price?: number | null; note?: string } = {},
): Promise<ChiffrageLine> {
  const db = supabase();
  if (!db) throw new Error('Revue indisponible : Supabase non configuré');

  const patch: Record<string, unknown> = { reviewed_at: new Date().toISOString() };
  if (options.note !== undefined) patch.review_note = options.note || null;

  if (action === 'valider') {
    patch.status = 'validee';
  } else if (action === 'forcer') {
    if (options.price == null || !Number.isFinite(options.price) || options.price < 0) {
      throw new Error('Un prix imposé doit être un nombre positif');
    }
    patch.status = 'forcee';
    patch.forced_price = options.price;
    patch.unit_price = options.price;
  } else if (action === 'manuel') {
    // Sans prix, explicitement: la ligne part à compléter à la main.
    patch.status = 'manuelle';
    patch.unit_price = null;
    patch.total_price = null;
  } else if (action === 'rejeter') {
    patch.status = 'rejetee';
  } else {
    // Recalcul: la consigne est gardée, la ligne repasse à traiter.
    patch.status = 'a_traiter';
  }

  const { data, error } = await db
    .from('request_lines')
    .update(patch)
    .eq('id', lineId)
    .select()
    .single();
  if (error) throw new Error(`Décision non enregistrée: ${error.message}`);

  logger.info({ lineId, action, price: options.price }, 'Revue technique: décision enregistrée');
  return fromLineRow(data);
}

/** Les lignes d'une demande, dans l'ordre où le mail les donnait. */
export async function listRequestLines(id: string): Promise<ChiffrageLine[]> {
  const db = supabase();
  if (!db) return [];

  const { data, error } = await db
    .from('request_lines')
    .select('*')
    .eq('work_id', id)
    .order('position', { ascending: true });
  if (error) throw new Error(`Lecture des lignes impossible: ${error.message}`);

  return (data ?? []).map(fromLineRow);
}

// ── Prix par défaut, par client ──────────────────────────────────

export interface ClientPricing {
  client: string;
  defaultUnitPrice: number | null;
  currency: string;
  note?: string;
  updatedAt: string;
}

/**
 * Le prix par défaut d'un client.
 *
 * Ce n'est pas un prix calculé et ça ne prétend pas l'être: aucun moteur de
 * coût n'existe encore. C'est une valeur posée à la main, affichée comme
 * telle, que l'opérateur ajuste par donneur d'ordres. La nommer « par défaut »
 * partout est ce qui empêche qu'elle finisse un jour dans un devis en se
 * faisant passer pour une estimation.
 */
export async function getClientPricing(client: string): Promise<ClientPricing | null> {
  const db = supabase();
  if (!db) return null;

  const { data, error } = await db.from('client_pricing').select('*').eq('client', client).maybeSingle();
  if (error) throw new Error(`Lecture du prix client impossible: ${error.message}`);
  return data ? toPricing(data) : null;
}

export async function listClientPricing(): Promise<ClientPricing[]> {
  const db = supabase();
  if (!db) return [];

  const { data, error } = await db.from('client_pricing').select('*').order('client');
  if (error) throw new Error(`Lecture des prix clients impossible: ${error.message}`);
  return (data ?? []).map(toPricing);
}

export async function setClientPricing(
  client: string,
  defaultUnitPrice: number | null,
  note?: string,
): Promise<ClientPricing> {
  const db = supabase();
  if (!db) throw new Error('Prix client indisponible : Supabase non configuré');

  const row = {
    client,
    default_unit_price: defaultUnitPrice,
    currency: 'EUR',
    note: note ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from('client_pricing')
    .upsert(row, { onConflict: 'client' })
    .select()
    .single();
  if (error) throw new Error(`Prix client non enregistré: ${error.message}`);

  logger.info({ client, defaultUnitPrice }, 'Prix par défaut du client modifié');
  return toPricing(data);
}

function toPricing(row: any): ClientPricing {
  return {
    client: row.client,
    defaultUnitPrice: row.default_unit_price === null ? null : Number(row.default_unit_price),
    currency: row.currency ?? 'EUR',
    note: row.note ?? undefined,
    updatedAt: row.updated_at,
  };
}

// ── The deliverables themselves ──────────────────────────────────

/**
 * Keeps one produced file in our own storage and indexes it against its job.
 *
 * Returns null when Supabase is not configured: the job is still recorded, but
 * the file exists only on Dropbox. A storage failure is logged and swallowed —
 * a plan that reached Dropbox must not be reported as a failed delivery
 * because our copy could not be written.
 */
export async function addWorkFile(input: {
  tool: WorkTool;
  ref: string;
  kind: WorkFileKind;
  fileName: string;
  bytes: Buffer;
  partId?: string;
  contentType?: string;
}): Promise<WorkFileRecord | null> {
  const db = supabase();
  const storage = supabaseStorage();
  if (!db || !storage) return null;

  const id = crypto.randomUUID();
  const storagePath = `${input.tool}/${input.ref}/${input.kind}/${id}-${input.fileName}`;

  try {
    const { error: upErr } = await storage.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, input.bytes, {
        contentType: input.contentType ?? 'application/octet-stream',
        upsert: false,
      });
    if (upErr) throw new Error(upErr.message);

    const row = {
      id,
      work_id: workId(input.tool, input.ref),
      created_at: new Date().toISOString(),
      kind: input.kind,
      part_id: input.partId ?? null,
      file_name: input.fileName,
      storage_path: storagePath,
      byte_size: input.bytes.length,
    };

    const { error: dbErr } = await db.from('work_files').insert(row);
    if (dbErr) throw new Error(dbErr.message);

    return {
      id,
      workId: row.work_id,
      createdAt: row.created_at,
      kind: input.kind,
      partId: input.partId,
      fileName: input.fileName,
      storagePath,
      byteSize: input.bytes.length,
    };
  } catch (err: any) {
    logger.error(
      { err: err.message, ref: input.ref, kind: input.kind, fileName: input.fileName },
      'Livrable non archivé — il reste sur Dropbox',
    );
    return null;
  }
}

/** The files of one job, each with a short-lived signed URL. */
export async function listWorkFiles(
  id: string,
): Promise<Array<WorkFileRecord & { url: string | null }>> {
  const db = supabase();
  const storage = supabaseStorage();
  if (!db || !storage) return [];

  const { data, error } = await db
    .from('work_files')
    .select('*')
    .eq('work_id', id)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Lecture des livrables impossible: ${error.message}`);

  const rows = (data ?? []) as Array<{
    id: string;
    work_id: string;
    created_at: string;
    kind: WorkFileKind;
    part_id: string | null;
    file_name: string;
    storage_path: string;
    byte_size: number;
  }>;

  return Promise.all(
    rows.map(async (r) => {
      const { data: signed } = await storage.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(r.storage_path, SIGNED_URL_TTL_SECONDS);
      return {
        id: r.id,
        workId: r.work_id,
        createdAt: r.created_at,
        kind: r.kind,
        partId: r.part_id ?? undefined,
        fileName: r.file_name,
        storagePath: r.storage_path,
        byteSize: r.byte_size,
        url: signed?.signedUrl ?? null,
      };
    }),
  );
}

/**
 * Combien de lignes porte chaque demande.
 *
 * Compté sur les lignes elles-mêmes, pas sur les références de pièces: un
 * client qui décrit « boitier, aluminium, 32 pièces » sans donner de référence
 * a bel et bien passé une ligne, et l'afficher à zéro donnerait l'impression
 * d'une demande vide.
 */
export async function requestLineCounts(ids: string[]): Promise<Record<string, number>> {
  const db = supabase();
  if (!db || ids.length === 0) return {};

  const { data, error } = await db.from('request_lines').select('work_id').in('work_id', ids);
  if (error) throw new Error(`Comptage des lignes impossible: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as Array<{ work_id: string }>) {
    counts[row.work_id] = (counts[row.work_id] ?? 0) + 1;
  }
  return counts;
}

/** How many files each job has, for the list view. */
export async function workFileCounts(ids: string[]): Promise<Record<string, number>> {
  const db = supabase();
  if (!db || ids.length === 0) return {};

  const { data, error } = await db.from('work_files').select('work_id').in('work_id', ids);
  if (error) throw new Error(`Comptage des livrables impossible: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as Array<{ work_id: string }>) {
    counts[row.work_id] = (counts[row.work_id] ?? 0) + 1;
  }
  return counts;
}

/** Test seam: forget everything loaded from the local fallback. */
export function __resetForTests(): void {
  local.clear();
  loaded = false;
  persistence = true;
}
