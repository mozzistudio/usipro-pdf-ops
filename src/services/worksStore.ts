import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { supabase, supabaseStorage, STORAGE_BUCKET } from './supabaseClient';

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
  | 'zip';

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
