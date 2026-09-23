import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { supabase } from './supabaseClient';

/**
 * Le journal d'analyse d'une demande de chiffrage.
 *
 * Une demande arrive par mail, le serveur lit ses pièces jointes, un modèle en
 * extrait des articles, un moteur les chiffre. À l'arrivée, l'opérateur voit un
 * prix — mais rien ne lui dit ce qui a été réellement lu pour l'obtenir. Un plan
 * scanné sans couche texte, une image trop lourde pour partir au modèle, une
 * archive ouverte : autant de faits qui expliquent un prix faux et qui, jusqu'à
 * ce journal, ne survivaient que dans les logs du serveur.
 *
 * Le journal n'est pas une reconstruction : chaque ligne est écrite au moment
 * où le fait se produit, et n'est jamais modifiée ensuite. Ce qui n'y est pas
 * n'a pas eu lieu.
 */

export type AnalysisStage = 'lecture' | 'extraction' | 'chiffrage';
export type AnalysisLevel = 'info' | 'warn' | 'error';

export interface AnalysisEvent {
  workId: string;
  createdAt: string;
  /**
   * L'ordre du récit à l'intérieur d'un lot — les pièces jointes sont lues en
   * parallèle et reviennent dans le désordre. Entre deux lots (une analyse,
   * puis un rechiffrage six mois plus tard), c'est l'horodatage qui tranche.
   */
  position: number;
  stage: AnalysisStage;
  /** La pièce jointe concernée, quand l'événement en vise une. */
  fileName?: string | null;
  level: AnalysisLevel;
  message: string;
}

/** Ce qu'on écrit pendant l'analyse, avant même de connaître l'identifiant du travail. */
export type AnalysisEntry = Omit<AnalysisEvent, 'workId' | 'createdAt' | 'position'> &
  Partial<Pick<AnalysisEvent, 'createdAt'>>;

/**
 * Le carnet d'une analyse en cours.
 *
 * L'identifiant du travail n'existe qu'après l'extraction, alors que la lecture
 * des pièces jointes la précède. Les faits sont donc notés au fil de l'eau ici,
 * puis versés d'un coup quand la demande a une identité.
 */
export class AnalysisNotebook {
  private entries: AnalysisEntry[] = [];

  note(stage: AnalysisStage, message: string, options: { file?: string | null; level?: AnalysisLevel } = {}): void {
    this.entries.push({
      stage,
      message,
      fileName: options.file ?? null,
      level: options.level ?? 'info',
      createdAt: new Date().toISOString(),
    });
  }

  get length(): number {
    return this.entries.length;
  }

  /** Verse le carnet au journal. Ne lève jamais : perdre le journal ne doit pas perdre la demande. */
  async commit(workId: string): Promise<void> {
    if (this.entries.length === 0) return;
    const events: AnalysisEvent[] = this.entries.map((entry, index) => ({
      workId,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      position: index,
      stage: entry.stage,
      fileName: entry.fileName ?? null,
      level: entry.level,
      message: entry.message,
    }));
    this.entries = [];
    await recordAnalysis(events);
  }
}

// ── Correspondance avec la table ─────────────────────────────────

interface EventRow {
  work_id: string;
  created_at: string;
  position: number;
  stage: AnalysisStage;
  file_name: string | null;
  level: AnalysisLevel;
  message: string;
}

function toRow(event: AnalysisEvent): EventRow {
  return {
    work_id: event.workId,
    created_at: event.createdAt,
    position: event.position,
    stage: event.stage,
    file_name: event.fileName ?? null,
    level: event.level,
    message: event.message,
  };
}

function fromRow(row: EventRow): AnalysisEvent {
  return {
    workId: row.work_id,
    createdAt: row.created_at,
    position: row.position,
    stage: row.stage,
    fileName: row.file_name,
    level: row.level,
    message: row.message,
  };
}

// ── Repli local, quand Supabase n'est pas configuré ──────────────

let persistence = true;

function appendLocal(events: AnalysisEvent[]): void {
  if (!persistence) return;
  try {
    fs.mkdirSync(path.dirname(config.analysis.path), { recursive: true });
    fs.appendFileSync(
      config.analysis.path,
      events.map(e => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
  } catch (err: any) {
    persistence = false;
    logger.error({ err: err.message }, 'Journal d’analyse non écrit — analyse non tracée');
  }
}

function readLocal(workId: string): AnalysisEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(config.analysis.path, 'utf8');
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      logger.warn({ err: err.message }, 'Journal d’analyse local illisible');
    }
    return [];
  }

  const out: AnalysisEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as AnalysisEvent;
      if (event?.workId === workId) out.push(event);
    } catch {
      // Une ligne cassée est un fait perdu, pas une raison de perdre le fichier.
    }
  }
  // Une demande rechiffrée écrit un second lot, dont les positions repartent
  // de zéro : c'est l'horodatage qui ordonne les lots, la position les faits
  // d'un même lot.
  return out.sort((a, b) =>
    a.createdAt === b.createdAt ? a.position - b.position : a.createdAt.localeCompare(b.createdAt),
  );
}

// ── Écriture et lecture ──────────────────────────────────────────

/**
 * Écrit des faits au journal.
 *
 * N'échoue jamais bruyamment : une demande enregistrée sans son journal reste
 * une demande utilisable, alors qu'une demande perdue faute de journal serait
 * un mail client jeté.
 */
export async function recordAnalysis(events: AnalysisEvent[]): Promise<void> {
  if (events.length === 0) return;

  const db = supabase();
  if (!db) {
    appendLocal(events);
    return;
  }

  const { error } = await db.from('analysis_events').insert(events.map(toRow));
  if (error) {
    logger.warn({ err: error.message, workId: events[0].workId }, 'Journal d’analyse non enregistré');
  }
}

/** Le journal d'une demande, dans l'ordre du récit. */
export async function listAnalysis(workId: string): Promise<AnalysisEvent[]> {
  const db = supabase();
  if (!db) return readLocal(workId);

  const { data, error } = await db
    .from('analysis_events')
    .select('*')
    .eq('work_id', workId)
    .order('created_at', { ascending: true })
    .order('position', { ascending: true });
  if (error) throw new Error(`Lecture du journal impossible: ${error.message}`);
  return ((data ?? []) as EventRow[]).map(fromRow);
}
