import { logger } from '../utils/logger';
import { supabase } from './supabaseClient';
import {
  DEFAULT_SETTINGS,
  MaterialRate,
  PricingSettings,
  Shop,
  ShopMachine,
  ShopRate,
  ShopTechnique,
} from './costEngine';
import {
  getPricingSettings,
  listMaterialRates,
  setMaterialRate,
  setPricingSettings,
} from './worksStore';

/**
 * Le paramétrage de l'atelier : ce sur quoi repose chaque prix proposé.
 *
 * Un taux horaire unique et trois courses de fraiseuse anonymes ne décrivent
 * pas un atelier. Ce module tient le reste — les taux par opération, le parc,
 * les techniques, les consignes, et les règles nées de la revue — avec deux
 * règles qui ne se négocient pas :
 *
 *   — rien n'agit sans validation explicite. Un commentaire de revue devient
 *     une règle *proposée* ; il faut un humain pour qu'elle entre en vigueur ;
 *   — l'historique est en ajout seul. Chaque changement écrit une version avec
 *     l'instantané complet d'après coup, et revenir en arrière écrit une
 *     version de plus. Six mois après, l'écart entre deux devis s'explique.
 *
 * Sans Supabase, la lecture rend les valeurs livrées — la page doit pouvoir
 * s'afficher sur un portable — et toute écriture échoue franchement plutôt que
 * de faire croire à un enregistrement.
 */

// ── Ce que le paramétrage contient ───────────────────────────────

export type RateScope = ShopRate['appliesTo'];

export interface OperationRate {
  id: string;
  label: string;
  ratePerHour: number;
  appliesTo: RateScope;
  position: number;
}

export interface Machine {
  id: string;
  label: string;
  kind: 'fraisage' | 'tournage' | 'autre';
  axes: number | null;
  travelXMm: number | null;
  travelYMm: number | null;
  travelZMm: number | null;
  maxDiameterMm: number | null;
  maxLengthMm: number | null;
  count: number;
  note: string | null;
  position: number;
}

export interface Technique {
  id: string;
  label: string;
  status: 'interne' | 'sous_traitee' | 'non';
  note: string | null;
  position: number;
}

export interface Instruction {
  id: string;
  createdAt: string;
  text: string;
  status: 'active' | 'retiree';
  author: string | null;
  position: number;
}

export type RuleStatus = 'a_valider' | 'active' | 'rejetee' | 'retiree';

export interface PricingRule {
  id: string;
  createdAt: string;
  text: string;
  status: RuleStatus;
  origin: 'revue' | 'manuel';
  workId: string | null;
  author: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  sinceVersion: number | null;
}

export interface ParameterVersion {
  version: number;
  createdAt: string;
  author: string | null;
  summary: string;
  kind: 'modification' | 'retour';
  restoredFrom: number | null;
}

export interface Parametrage {
  settings: PricingSettings;
  materials: MaterialRate[];
  rates: OperationRate[];
  machines: Machine[];
  techniques: Technique[];
  instructions: Instruction[];
  rules: PricingRule[];
  versions: ParameterVersion[];
  /** Les tables que la migration 004 n'a pas encore posées. Vide quand la base est à jour. */
  pending: string[];
  /** Faux quand le stockage manque : la page doit le dire au lieu de laisser croire que tout est enregistrable. */
  writable: boolean;
}

/** L'instantané écrit dans l'historique — tout ce qu'une version doit pouvoir rendre. */
interface Snapshot {
  settings: PricingSettings;
  materials: MaterialRate[];
  rates: OperationRate[];
  machines: Machine[];
  techniques: Technique[];
  instructions: Instruction[];
  rules: Array<{ id: string; status: RuleStatus }>;
}

// ── Les valeurs livrées ──────────────────────────────────────────
//
// Les mêmes que les `insert` de la migration : sur un poste sans base, la page
// montre l'atelier tel qu'il sortira de la première mise en service, et non
// une page vide qui donnerait à croire qu'il n'y a rien à paramétrer.

const DEFAULT_RATES: OperationRate[] = [
  { id: 'tournage_cn', label: 'Tournage CN', ratePerHour: DEFAULT_SETTINGS.hourlyRate, appliesTo: 'tournage', position: 0 },
  { id: 'fraisage_3axes', label: 'Fraisage 3 axes', ratePerHour: DEFAULT_SETTINGS.hourlyRate, appliesTo: 'fraisage_3', position: 1 },
  { id: 'fraisage_5axes', label: 'Fraisage 5 axes', ratePerHour: DEFAULT_SETTINGS.hourlyRate, appliesTo: 'fraisage_5', position: 2 },
  { id: 'reglage', label: 'Réglage / démarrage', ratePerHour: DEFAULT_SETTINGS.hourlyRate, appliesTo: 'reglage', position: 3 },
];

const DEFAULT_MACHINES: Machine[] = [
  {
    id: 'centre_3axes', label: 'Centre 3 axes', kind: 'fraisage', axes: 3,
    travelXMm: DEFAULT_SETTINGS.millingTravelXMm,
    travelYMm: DEFAULT_SETTINGS.millingTravelYMm,
    travelZMm: DEFAULT_SETTINGS.millingTravelZMm,
    maxDiameterMm: null, maxLengthMm: null, count: 1, note: null, position: 0,
  },
];

const DEFAULT_TECHNIQUES: Technique[] = [
  { id: 'tournage', label: 'Tournage CN', status: 'interne', note: null, position: 0 },
  { id: 'fraisage_3', label: 'Fraisage 3 axes', status: 'interne', note: null, position: 1 },
  { id: 'fraisage_5', label: 'Fraisage 5 axes', status: 'non', note: 'Repositionnement en 3 axes', position: 2 },
  { id: 'debit_tole', label: 'Débit tôle', status: 'interne', note: null, position: 3 },
  { id: 'rectification', label: 'Rectification', status: 'sous_traitee', note: 'Plats rectifiés achetés', position: 4 },
  { id: 'traitement', label: 'Traitements de surface', status: 'sous_traitee', note: 'Anodisation, passivation', position: 5 },
];

const NO_DB = 'Paramétrage non enregistrable : Supabase non configuré';

/**
 * Poser ou corriger une ligne, sans jamais l'écraser à moitié.
 *
 * `upsert` semblait fait pour ça, et ne l'est pas : PostgREST envoie un INSERT
 * avec les seules colonnes passées, et Postgres vérifie les contraintes du
 * tuple proposé AVANT de résoudre le conflit. Corriger le seul taux d'une
 * opération partait donc avec `label` à NULL et se faisait refuser — sur une
 * ligne qui existait déjà, et dont le libellé n'avait pas bougé.
 *
 * Une ligne connue se met donc à jour, une ligne neuve s'insère. C'est aussi
 * ce que fait le tarif matière depuis toujours.
 */
async function writeRow(
  db: any,
  table: string,
  id: string,
  row: Record<string, unknown>,
  exists: boolean,
  what: string,
): Promise<void> {
  const { error } = exists
    ? await db.from(table).update(row).eq('id', id)
    : await db.from(table).insert({ ...row, id });
  if (error) throw new Error(`${what} non enregistré: ${error.message}`);
}

// ── Lecture ──────────────────────────────────────────────────────

function num(value: unknown): number | null {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? null : n;
}

function rateFromRow(row: any): OperationRate {
  return {
    id: row.id,
    label: row.label,
    ratePerHour: Number(row.rate_per_hour),
    appliesTo: row.applies_to,
    position: Number(row.position ?? 0),
  };
}

function machineFromRow(row: any): Machine {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    axes: num(row.axes),
    travelXMm: num(row.travel_x_mm),
    travelYMm: num(row.travel_y_mm),
    travelZMm: num(row.travel_z_mm),
    maxDiameterMm: num(row.max_diameter_mm),
    maxLengthMm: num(row.max_length_mm),
    count: Number(row.count ?? 1),
    note: row.note ?? null,
    position: Number(row.position ?? 0),
  };
}

function techniqueFromRow(row: any): Technique {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    note: row.note ?? null,
    position: Number(row.position ?? 0),
  };
}

function instructionFromRow(row: any): Instruction {
  return {
    id: row.id,
    createdAt: row.created_at,
    text: row.text,
    status: row.status,
    author: row.author ?? null,
    position: Number(row.position ?? 0),
  };
}

function ruleFromRow(row: any): PricingRule {
  return {
    id: row.id,
    createdAt: row.created_at,
    text: row.text,
    status: row.status,
    origin: row.origin,
    workId: row.work_id ?? null,
    author: row.author ?? null,
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decided_by ?? null,
    sinceVersion: num(row.since_version),
  };
}

function versionFromRow(row: any): ParameterVersion {
  return {
    version: Number(row.version),
    createdAt: row.created_at,
    author: row.author ?? null,
    summary: row.summary,
    kind: row.kind,
    restoredFrom: num(row.restored_from),
  };
}

/**
 * Une table qui n'existe pas encore n'est pas une panne.
 *
 * Le code et la migration ne partent pas toujours ensemble : entre le
 * déploiement et le `psql`, la base porte l'ancien schéma. L'écran doit alors
 * montrer ce qu'il sait — les paramètres du moteur, les matières, qui eux
 * existent — et nommer précisément ce qui manque, plutôt que de mourir sur un
 * message PostgREST que personne ne sait traduire en « lance la migration ».
 */
function isMissingTable(message: string): boolean {
  return /could not find the table|does not exist|schema cache/i.test(message);
}

/**
 * Un échec traduit en geste.
 *
 * « Could not find the table 'usipro.pricing_rules' in the schema cache » est
 * exact et inutile : personne n'en déduit qu'il faut lancer une migration. On
 * dit donc quoi faire, et on garde la phrase d'origine derrière.
 */
export function explain(err: any): string {
  const message = String(err?.message ?? err ?? 'erreur inconnue');
  if (!isMissingTable(message)) return message;
  return 'la base n’a pas encore les tables du paramétrage — applique db/004_parametrage.sql ' +
    `(détail : ${message})`;
}

/** Les tables posées par `db/004_parametrage.sql` et absentes de la base. */
const PENDING: Set<string> = new Set();

async function readTable<T>(table: string, run: (db: any) => Promise<T>, fallback: T): Promise<T> {
  const db = supabase();
  if (!db) return fallback;

  try {
    const value = await run(db);
    PENDING.delete(table);
    return value;
  } catch (err: any) {
    if (!isMissingTable(err.message ?? '')) throw err;
    if (!PENDING.has(table)) {
      logger.warn({ table }, 'Table du paramétrage absente — migration 004 pas encore passée');
      PENDING.add(table);
    }
    return fallback;
  }
}

export async function listOperationRates(): Promise<OperationRate[]> {
  return readTable('operation_rates', async db => {
    const { data, error } = await db.from('operation_rates').select('*').order('position');
    if (error) throw new Error(`Lecture des taux horaires impossible: ${error.message}`);
    return (data ?? []).map(rateFromRow);
  }, DEFAULT_RATES);
}

export async function listMachines(): Promise<Machine[]> {
  return readTable('machines', async db => {
    const { data, error } = await db.from('machines').select('*').order('position');
    if (error) throw new Error(`Lecture du parc machines impossible: ${error.message}`);
    return (data ?? []).map(machineFromRow);
  }, DEFAULT_MACHINES);
}

export async function listTechniques(): Promise<Technique[]> {
  return readTable('techniques', async db => {
    const { data, error } = await db.from('techniques').select('*').order('position');
    if (error) throw new Error(`Lecture des techniques impossible: ${error.message}`);
    return (data ?? []).map(techniqueFromRow);
  }, DEFAULT_TECHNIQUES);
}

export async function listInstructions(): Promise<Instruction[]> {
  return readTable('instructions', async db => {
    const { data, error } = await db.from('instructions').select('*').order('position');
    if (error) throw new Error(`Lecture des consignes impossible: ${error.message}`);
    return (data ?? []).map(instructionFromRow);
  }, [] as Instruction[]);
}

export async function listRules(): Promise<PricingRule[]> {
  return readTable('pricing_rules', async db => {
    const { data, error } = await db.from('pricing_rules').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(`Lecture des règles impossible: ${error.message}`);
    return (data ?? []).map(ruleFromRow);
  }, [] as PricingRule[]);
}

/** L'historique, le plus récent d'abord. L'instantané reste en base : il sert au retour arrière, pas à l'affichage. */
export async function listVersions(limit = 40): Promise<ParameterVersion[]> {
  return readTable('parameter_versions', async db => {
    const { data, error } = await db
      .from('parameter_versions')
      .select('version, created_at, author, summary, kind, restored_from')
      .order('version', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Lecture de l'historique impossible: ${error.message}`);
    return (data ?? []).map(versionFromRow);
  }, [] as ParameterVersion[]);
}

/** Tout le paramétrage, en une lecture : c'est ce que la page affiche. */
export async function getParametrage(): Promise<Parametrage> {
  const [settings, materials, rates, machines, techniques, instructions, rules, versions] =
    await Promise.all([
      getPricingSettings(),
      listMaterialRates(),
      listOperationRates(),
      listMachines(),
      listTechniques(),
      listInstructions(),
      listRules(),
      listVersions(),
    ]);

  return {
    settings, materials, rates, machines, techniques, instructions, rules, versions,
    pending: [...PENDING].sort(),
    // Écrire dans une table absente échouerait : mieux vaut une page en
    // lecture seule qui dit pourquoi qu'un formulaire qui promet et perd.
    writable: supabase() !== null && PENDING.size === 0,
  };
}

// ── Ce que le moteur en retient ──────────────────────────────────

/**
 * L'atelier tel que le moteur de coût le voit.
 *
 * Seules les techniques et les machines entrent ici : les consignes et les
 * règles parlent au modèle, pas au calcul, et les mélanger ferait croire à un
 * effet déterministe qui n'existe pas.
 */
export async function shopProfile(): Promise<Shop> {
  const [rates, machines, techniques] = await Promise.all([
    listOperationRates(),
    listMachines(),
    listTechniques(),
  ]);

  const shopRates: ShopRate[] = rates.map(r => ({
    label: r.label,
    ratePerHour: r.ratePerHour,
    appliesTo: r.appliesTo,
  }));

  const shopMachines: ShopMachine[] = machines.map(m => ({
    label: m.label,
    kind: m.kind,
    axes: m.axes,
    travelXMm: m.travelXMm,
    travelYMm: m.travelYMm,
    travelZMm: m.travelZMm,
    maxDiameterMm: m.maxDiameterMm,
    maxLengthMm: m.maxLengthMm,
    count: m.count,
  }));

  const shopTechniques: ShopTechnique[] = techniques.map(t => ({
    id: t.id,
    label: t.label,
    status: t.status,
  }));

  return { rates: shopRates, machines: shopMachines, techniques: shopTechniques };
}

/**
 * Ce que l'atelier veut voir appliqué, en toutes lettres, pour les prompts.
 *
 * Une règle validée et une consigne active entrent ici, et nulle part
 * ailleurs : c'est la seule chose qu'elles font. Le dire ainsi évite de
 * laisser croire qu'une phrase écrite dans cet écran modifie un calcul
 * déterministe — elle oriente une lecture, ce qui n'est pas la même promesse.
 */
export async function shopGuidance(): Promise<string> {
  const [rules, instructions] = await Promise.all([listRules(), listInstructions()]);

  const lines: string[] = [];
  for (const rule of rules.filter(r => r.status === 'active')) {
    lines.push(`- [${rule.id}] ${rule.text}`);
  }
  for (const instruction of instructions.filter(i => i.status === 'active')) {
    lines.push(`- ${instruction.text}`);
  }
  if (lines.length === 0) return '';

  return `RÈGLES ET CONSIGNES DE L'ATELIER (validées, à respecter):\n${lines.join('\n')}`;
}

// ── L'historique ─────────────────────────────────────────────────

async function snapshot(): Promise<Snapshot> {
  const [settings, materials, rates, machines, techniques, instructions, rules] = await Promise.all([
    getPricingSettings(),
    listMaterialRates(),
    listOperationRates(),
    listMachines(),
    listTechniques(),
    listInstructions(),
    listRules(),
  ]);

  return {
    settings, materials, rates, machines, techniques, instructions,
    rules: rules.map(r => ({ id: r.id, status: r.status })),
  };
}

/**
 * Écrit une version après un changement déjà appliqué.
 *
 * L'instantané est pris *après* : une version dit dans quel état le
 * paramétrage se trouve depuis elle, pas dans quel état il se trouvait avant.
 * C'est ce qui permet à un retour arrière de n'être qu'une relecture.
 *
 * Une version qui ne s'écrit pas ne doit pas annuler un changement déjà fait :
 * on le signale, sans faire échouer l'appel.
 */
async function recordVersion(
  summary: string,
  author: string | null,
  kind: 'modification' | 'retour' = 'modification',
  restoredFrom: number | null = null,
): Promise<ParameterVersion | null> {
  const db = supabase();
  if (!db) return null;

  try {
    const { data, error } = await db
      .from('parameter_versions')
      .insert({ summary, author, kind, restored_from: restoredFrom, snapshot: await snapshot() })
      .select('version, created_at, author, summary, kind, restored_from')
      .single();
    if (error) throw new Error(error.message);
    logger.info({ version: data.version, summary }, 'Version du paramétrage écrite');
    return versionFromRow(data);
  } catch (err: any) {
    logger.error({ err: err.message, summary }, 'Version du paramétrage non écrite — le changement, lui, est appliqué');
    return null;
  }
}

// ── Écriture ─────────────────────────────────────────────────────

/** Les paramètres du moteur, versionnés. */
export async function saveSettings(patch: Partial<PricingSettings>, author: string | null): Promise<PricingSettings> {
  const settings = await setPricingSettings(patch);
  const changed = Object.keys(patch);
  await recordVersion(
    changed.length === 1 ? `${labelOfSetting(changed[0])} modifié` : `${changed.length} paramètres du moteur modifiés`,
    author,
  );
  return settings;
}

const SETTING_LABELS: Record<string, string> = {
  hourlyRate: 'Taux horaire',
  setupMinutes: 'Mise en train',
  programmingMinutes: 'Programmation CAO',
  programmingMinutesMax: 'Programmation CAO (plafond)',
  minutesPerDm3: 'Minutes par dm³',
  removalRatio: 'Part de matière enlevée',
  learningCurve: 'Courbe d’apprentissage',
  marginPct: 'Marge',
  handlingMinutesPerPart: 'Reprise et contrôle',
  millingTravelXMm: 'Course X',
  millingTravelYMm: 'Course Y',
  millingTravelZMm: 'Course Z',
  sheetMaxThicknessMm: 'Épaisseur maxi tôle',
  sheetMinFormatMm: 'Format mini tôle',
  sheetRemovalRatio: 'Matière enlevée en débit tôle',
  groundAluminiumFactor: 'Facteur alu rectifié',
  groundInoxFactor: 'Facteur inox rectifié',
};

function labelOfSetting(key: string): string {
  return SETTING_LABELS[key] ?? key;
}

/** Le tarif d'une nuance, versionné. */
export async function saveMaterial(
  id: string,
  patch: { pricePerKg?: number; density?: number; label?: string; aliases?: string[] },
  author: string | null,
): Promise<MaterialRate[]> {
  const materials = await setMaterialRate(id, patch);
  const label = materials.find(m => m.id === id)?.label ?? id;
  await recordVersion(`Tarif ${label} mis à jour`, author);
  return materials;
}

/** Un taux horaire posé ou corrigé. */
export async function saveOperationRate(
  rate: { id: string; label?: string; ratePerHour?: number; appliesTo?: RateScope; position?: number },
  author: string | null,
): Promise<OperationRate[]> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const before = (await listOperationRates()).find(r => r.id === rate.id);
  const row: Record<string, unknown> = { id: rate.id, updated_at: new Date().toISOString() };
  if (rate.label !== undefined) row.label = rate.label;
  if (rate.ratePerHour !== undefined) row.rate_per_hour = rate.ratePerHour;
  if (rate.appliesTo !== undefined) row.applies_to = rate.appliesTo;
  if (rate.position !== undefined) row.position = rate.position;

  // Un taux créé sans libellé serait une ligne anonyme dans le tarif.
  if (!before && row.label === undefined) throw new Error('Un nouveau taux doit porter un libellé');
  if (!before && row.rate_per_hour === undefined) throw new Error('Un nouveau taux doit porter un montant');

  await writeRow(db, 'operation_rates', rate.id, row, !!before, 'Taux horaire');

  const rates = await listOperationRates();
  const after = rates.find(r => r.id === rate.id);
  const summary = before && after && before.ratePerHour !== after.ratePerHour
    ? `${after.label} ${before.ratePerHour} → ${after.ratePerHour} €/h`
    : before
      ? `${after?.label ?? rate.id} modifié`
      : `${after?.label ?? rate.id} ajouté`;
  await recordVersion(summary, author);
  return rates;
}

export async function deleteOperationRate(id: string, author: string | null): Promise<OperationRate[]> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const before = (await listOperationRates()).find(r => r.id === id);
  const { error } = await db.from('operation_rates').delete().eq('id', id);
  if (error) throw new Error(`Taux horaire non supprimé: ${error.message}`);

  await recordVersion(`${before?.label ?? id} retiré des taux`, author);
  return listOperationRates();
}

/** Une machine entre au parc, ou y change de capacité. */
export async function saveMachine(
  machine: Partial<Machine> & { id: string },
  author: string | null,
): Promise<Machine[]> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const before = (await listMachines()).find(m => m.id === machine.id);
  const row: Record<string, unknown> = { id: machine.id, updated_at: new Date().toISOString() };
  const map: Array<[keyof Machine, string]> = [
    ['label', 'label'], ['kind', 'kind'], ['axes', 'axes'],
    ['travelXMm', 'travel_x_mm'], ['travelYMm', 'travel_y_mm'], ['travelZMm', 'travel_z_mm'],
    ['maxDiameterMm', 'max_diameter_mm'], ['maxLengthMm', 'max_length_mm'],
    ['count', 'count'], ['note', 'note'], ['position', 'position'],
  ];
  for (const [key, column] of map) {
    if (machine[key] !== undefined) row[column] = machine[key];
  }
  if (!before && row.label === undefined) throw new Error('Une machine doit porter un nom');

  await writeRow(db, 'machines', machine.id, row, !!before, 'Machine');

  const machines = await listMachines();
  const after = machines.find(m => m.id === machine.id);
  await recordVersion(
    before ? `${after?.label ?? machine.id} modifiée au parc` : `${after?.label ?? machine.id} ajoutée au parc`,
    author,
  );
  return machines;
}

export async function deleteMachine(id: string, author: string | null): Promise<Machine[]> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const before = (await listMachines()).find(m => m.id === id);
  const { error } = await db.from('machines').delete().eq('id', id);
  if (error) throw new Error(`Machine non retirée: ${error.message}`);

  await recordVersion(`${before?.label ?? id} retirée du parc`, author);
  return listMachines();
}

/** Ce que l'atelier fait, sous-traite, ou ne fait pas. */
export async function saveTechnique(
  technique: Partial<Technique> & { id: string },
  author: string | null,
): Promise<Technique[]> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const before = (await listTechniques()).find(t => t.id === technique.id);
  const row: Record<string, unknown> = { id: technique.id, updated_at: new Date().toISOString() };
  if (technique.label !== undefined) row.label = technique.label;
  if (technique.status !== undefined) row.status = technique.status;
  if (technique.note !== undefined) row.note = technique.note;
  if (technique.position !== undefined) row.position = technique.position;
  if (!before && row.label === undefined) throw new Error('Une technique doit porter un nom');

  await writeRow(db, 'techniques', technique.id, row, !!before, 'Technique');

  const techniques = await listTechniques();
  const after = techniques.find(t => t.id === technique.id);
  const said: Record<Technique['status'], string> = {
    interne: 'faite en interne',
    sous_traitee: 'sous-traitée',
    non: 'hors du champ',
  };
  await recordVersion(
    before && after && before.status !== after.status
      ? `${after.label} : ${said[after.status]}`
      : `${after?.label ?? technique.id} ${before ? 'modifiée' : 'ajoutée'}`,
    author,
  );
  return techniques;
}

/** Une consigne générale, telle que l'atelier l'écrit. */
export async function addInstruction(text: string, author: string | null): Promise<Instruction[]> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const existing = await listInstructions();
  const { error } = await db.from('instructions').insert({
    text,
    author,
    position: existing.length,
  });
  if (error) throw new Error(`Consigne non enregistrée: ${error.message}`);

  await recordVersion('Consigne générale ajoutée', author);
  return listInstructions();
}

/**
 * Retirer une consigne ne l'efface pas.
 *
 * Elle a servi : des devis partis chez des clients ont été lus avec elle, et
 * la supprimer rendrait ces devis inexplicables. Elle cesse simplement
 * d'entrer dans les prompts suivants.
 */
export async function retireInstruction(id: string, author: string | null): Promise<Instruction[]> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const { error } = await db.from('instructions').update({ status: 'retiree' }).eq('id', id);
  if (error) throw new Error(`Consigne non retirée: ${error.message}`);

  await recordVersion('Consigne générale retirée', author);
  return listInstructions();
}

/** Le prochain identifiant de règle : R1, R2, … Lisible, et cité tel quel en revue. */
async function nextRuleId(): Promise<string> {
  const rules = await listRules();
  let max = 0;
  for (const rule of rules) {
    const match = /^R(\d+)$/.exec(rule.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `R${max + 1}`;
}

/**
 * Une règle proposée.
 *
 * Elle n'agit pas. C'est tout son intérêt : un technicien peut écrire ce qu'il
 * a constaté sur une pièce sans engager tous les devis de l'atelier, et
 * quelqu'un décide ensuite si cela vaut règle.
 */
export async function proposeRule(
  input: { text: string; origin?: 'revue' | 'manuel'; workId?: string | null; author?: string | null },
): Promise<PricingRule[]> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const id = await nextRuleId();
  const { error } = await db.from('pricing_rules').insert({
    id,
    text: input.text,
    origin: input.origin ?? 'manuel',
    work_id: input.workId ?? null,
    author: input.author ?? null,
    status: 'a_valider',
  });
  if (error) throw new Error(`Règle non enregistrée: ${error.message}`);

  // Pas de version ici : une règle proposée ne change pas le paramétrage.
  logger.info({ id, origin: input.origin ?? 'manuel' }, 'Règle proposée');
  return listRules();
}

/**
 * La décision sur une règle.
 *
 * Seule l'activation écrit une version : c'est le moment où la règle commence
 * à entrer dans les prompts, donc le moment où les devis suivants cessent de
 * ressembler aux précédents.
 */
export async function decideRule(
  id: string,
  decision: 'valider' | 'rejeter' | 'retirer',
  author: string | null,
): Promise<PricingRule[]> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const rule = (await listRules()).find(r => r.id === id);
  if (!rule) throw new Error(`Règle ${id} introuvable`);

  const status: RuleStatus =
    decision === 'valider' ? 'active' : decision === 'rejeter' ? 'rejetee' : 'retiree';

  const { error } = await db
    .from('pricing_rules')
    .update({ status, decided_at: new Date().toISOString(), decided_by: author })
    .eq('id', id);
  if (error) throw new Error(`Décision non enregistrée: ${error.message}`);

  if (decision === 'valider') {
    const version = await recordVersion(`${id} ajoutée${author ? ` · ${author}` : ''}`, author);
    if (version) {
      await db.from('pricing_rules').update({ since_version: version.version }).eq('id', id);
    }
  } else if (decision === 'retirer') {
    await recordVersion(`${id} retirée${author ? ` · ${author}` : ''}`, author);
  }

  return listRules();
}

/**
 * Le retour à une version antérieure.
 *
 * On relit son instantané et on le réécrit — puis on écrit une version de
 * plus. L'historique ne recule jamais, même quand le paramétrage recule : ce
 * qui a été appliqué un jour doit rester lisible le jour où un client demande
 * pourquoi son prix a changé.
 *
 * Les règles apparues après la version relue gardent leur état : ce sont des
 * faits plus récents que le paramétrage, pas des paramètres à rembobiner.
 */
export async function restoreVersion(version: number, author: string | null): Promise<Parametrage> {
  const db = supabase();
  if (!db) throw new Error(NO_DB);

  const { data, error } = await db
    .from('parameter_versions')
    .select('version, snapshot')
    .eq('version', version)
    .maybeSingle();
  if (error) throw new Error(`Lecture de la version impossible: ${error.message}`);
  if (!data) throw new Error(`Version ${version} introuvable`);

  const snap = data.snapshot as Snapshot;

  await setPricingSettings(snap.settings);

  for (const material of snap.materials ?? []) {
    await setMaterialRate(material.id, {
      pricePerKg: material.pricePerKg,
      density: material.density,
      label: material.label,
      aliases: material.aliases,
    });
  }

  await replaceAll(db, 'operation_rates', (snap.rates ?? []).map(r => ({
    id: r.id, label: r.label, rate_per_hour: r.ratePerHour, applies_to: r.appliesTo, position: r.position,
  })));

  await replaceAll(db, 'machines', (snap.machines ?? []).map(m => ({
    id: m.id, label: m.label, kind: m.kind, axes: m.axes,
    travel_x_mm: m.travelXMm, travel_y_mm: m.travelYMm, travel_z_mm: m.travelZMm,
    max_diameter_mm: m.maxDiameterMm, max_length_mm: m.maxLengthMm,
    count: m.count, note: m.note, position: m.position,
  })));

  await replaceAll(db, 'techniques', (snap.techniques ?? []).map(t => ({
    id: t.id, label: t.label, status: t.status, note: t.note, position: t.position,
  })));

  // Les consignes portent un identifiant stable : on rétablit leur état plutôt
  // que de les recréer, pour qu'une consigne relue garde sa date d'origine.
  for (const instruction of snap.instructions ?? []) {
    await db.from('instructions').upsert({
      id: instruction.id,
      created_at: instruction.createdAt,
      text: instruction.text,
      status: instruction.status,
      author: instruction.author,
      position: instruction.position,
    }, { onConflict: 'id' });
  }
  const keptIds = new Set((snap.instructions ?? []).map(i => i.id));
  for (const live of await listInstructions()) {
    if (!keptIds.has(live.id) && live.status === 'active') {
      await db.from('instructions').update({ status: 'retiree' }).eq('id', live.id);
    }
  }

  for (const rule of snap.rules ?? []) {
    await db.from('pricing_rules').update({ status: rule.status }).eq('id', rule.id);
  }

  await recordVersion(`Retour à la version v${version}`, author, 'retour', version);
  logger.info({ version, author }, 'Paramétrage revenu à une version antérieure');
  return getParametrage();
}

/**
 * Remet une table dans l'état d'un instantané : ce qui y était revient, ce qui
 * n'y était pas s'en va. Réservé aux tables dont les lignes sont des
 * paramètres — jamais à celles qui portent une décision humaine datée.
 */
async function replaceAll(db: any, table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  const ids = rows.map(r => r.id as string);
  if (ids.length > 0) {
    const { error } = await db.from(table).upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`Restauration de ${table} impossible: ${error.message}`);
    const { error: delErr } = await db.from(table).delete().not('id', 'in', `(${ids.map(i => `"${i}"`).join(',')})`);
    if (delErr) throw new Error(`Restauration de ${table} impossible: ${delErr.message}`);
    return;
  }

  const { error } = await db.from(table).delete().neq('id', '');
  if (error) throw new Error(`Restauration de ${table} impossible: ${error.message}`);
}
