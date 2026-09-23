import crypto from 'crypto';
import { splitHeaderData } from './stepAnonymizer';

/**
 * Empreintes géométriques d'un fichier STEP.
 *
 * Le catalogue des cas produits pose une règle : l'identité de l'article se
 * décide avant le prix, et le nom ne décide jamais seul. Il faut donc pouvoir
 * répondre « est-ce la même pièce ? » à partir du fichier, pas de sa référence.
 *
 * Trois niveaux, du plus sûr au plus flou :
 *
 *  1. `dataSha256` — le hash de la section DATA, c'est-à-dire la géométrie sans
 *     l'en-tête que l'anonymisation réécrit. Deux fichiers qui partagent ce
 *     hash sont la même pièce, au bit près (ID-01).
 *
 *  2. Les invariants — nombre d'entités par type, nombre de points,
 *     encombrement. Ils survivent à un ré-export qui renumérote toutes les
 *     entités et reformate les flottants : le hash change, la pièce non
 *     (ID-03).
 *
 *  3. Le cartouche et le plan, traités ailleurs.
 *
 * Ce que ces empreintes ne savent PAS faire, et qu'il ne faut pas leur
 * demander : distinguer une pièce de sa symétrique (ID-07). Une pièce miroir a
 * les mêmes comptes d'entités et le même encombrement. C'est précisément
 * pourquoi un rattachement par invariants seuls est une proposition soumise à
 * l'opérateur, jamais une décision automatique.
 */

export interface StepFingerprint {
  /** Hash de la géométrie seule. Null si le fichier n'a pas de section DATA. */
  dataSha256: string | null;
  /** Nombre d'occurrences par type d'entité STEP, types rares ignorés. */
  entityCounts: Record<string, number>;
  /** Nombre de points cartésiens — l'invariant le plus simple et le plus stable. */
  pointCount: number;
  /**
   * Encombrement en millimètres, trié du plus grand au plus petit côté, pour
   * qu'une pièce exportée dans une autre orientation reste comparable.
   * Null quand le fichier ne contient aucun point exploitable.
   */
  bboxMm: [number, number, number] | null;
}

/** Types d'entités retenus : ceux qui décrivent la forme, pas la présentation. */
const TRACKED_ENTITIES = [
  'ADVANCED_FACE',
  'EDGE_CURVE',
  'VERTEX_POINT',
  'CARTESIAN_POINT',
  'CIRCLE',
  'PLANE',
  'CYLINDRICAL_SURFACE',
  'CONICAL_SURFACE',
  'TOROIDAL_SURFACE',
  'B_SPLINE_SURFACE_WITH_KNOTS',
  'CLOSED_SHELL',
  'MANIFOLD_SOLID_BREP',
];

/**
 * Les coordonnées des CARTESIAN_POINT. Le format tolère des espaces, des
 * exposants et des commentaires inline, d'où une regex sur le triplet complet
 * plutôt qu'un découpage sur les virgules.
 */
const POINT_RE =
  /CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*,\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*,\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*\)/g;

export function fingerprintStep(buffer: Buffer): StepFingerprint {
  const text = buffer.toString('latin1');
  const { data } = splitHeaderData(text);

  const geometry = data.trim();
  const dataSha256 = geometry
    ? crypto.createHash('sha256').update(normalise(geometry)).digest('hex')
    : null;

  const entityCounts: Record<string, number> = {};
  for (const name of TRACKED_ENTITIES) {
    // Le mot doit être suivi d'une parenthèse : sans ça, PLANE compterait
    // aussi les PLANE_ANGLE_MEASURE et l'invariant deviendrait du bruit.
    const matches = geometry.match(new RegExp(`\\b${name}\\s*\\(`, 'g'));
    if (matches) entityCounts[name] = matches.length;
  }

  let pointCount = 0;
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  POINT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = POINT_RE.exec(geometry)) !== null) {
    const coords = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (coords.some(c => !Number.isFinite(c))) continue;
    pointCount++;
    for (let i = 0; i < 3; i++) {
      if (coords[i] < min[i]) min[i] = coords[i];
      if (coords[i] > max[i]) max[i] = coords[i];
    }
  }

  const bboxMm: [number, number, number] | null =
    pointCount > 0
      ? (([max[0] - min[0], max[1] - min[1], max[2] - min[2]]
          .map(v => round(v))
          .sort((a, b) => b - a)) as [number, number, number])
      : null;

  return { dataSha256, entityCounts, pointCount, bboxMm };
}

/**
 * Normalise la géométrie avant hachage : les espaces et les fins de ligne
 * varient d'un exportateur à l'autre sans que la pièce change.
 */
function normalise(geometry: string): string {
  return geometry.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ── Comparaison ──────────────────────────────────────────────────

export type MatchKind =
  /** Même géométrie au bit près. */
  | 'identique'
  /** Invariants identiques, octets différents : pièce ré-exportée. */
  | 'reexport'
  /** Invariants très proches : même famille, une cote a bougé. */
  | 'voisin'
  /** Rien de commun. */
  | 'different';

export interface StepMatch {
  kind: MatchKind;
  /** 0 à 1. Sert à classer des candidats, pas à décider seul. */
  score: number;
  /** Ce qui plaide pour ce rattachement, en clair, pour l'écran opérateur. */
  reasons: string[];
}

/** Tolérance sur l'encombrement : en dessous, c'est du bruit d'export. */
const BBOX_TOLERANCE_MM = 0.01;
/** Au-delà de cet écart relatif sur une cote, ce n'est plus la même famille. */
const FAMILY_MAX_RELATIVE_GAP = 0.25;

export function compareFingerprints(a: StepFingerprint, b: StepFingerprint): StepMatch {
  const reasons: string[] = [];

  if (a.dataSha256 && b.dataSha256 && a.dataSha256 === b.dataSha256) {
    return {
      kind: 'identique',
      score: 1,
      reasons: ['géométrie identique au bit près'],
    };
  }

  const countsEqual = sameCounts(a.entityCounts, b.entityCounts);
  const bboxGap = bboxDelta(a.bboxMm, b.bboxMm);
  const pointsEqual = a.pointCount === b.pointCount && a.pointCount > 0;

  if (countsEqual && pointsEqual && bboxGap !== null && bboxGap <= BBOX_TOLERANCE_MM) {
    reasons.push(`${a.pointCount} points, mêmes comptes d'entités`);
    reasons.push('encombrement identique');
    return { kind: 'reexport', score: 0.95, reasons };
  }

  // Même forme, une cote qui bouge : la famille paramétrique du catalogue
  // (ID-08). Les comptes d'entités tiennent, l'encombrement diffère.
  const relative = relativeBboxGap(a.bboxMm, b.bboxMm);
  if (countsEqual && relative !== null && relative <= FAMILY_MAX_RELATIVE_GAP) {
    reasons.push("mêmes comptes d'entités");
    reasons.push(`encombrement différent de ${(relative * 100).toFixed(1)} %`);
    return { kind: 'voisin', score: 0.6, reasons };
  }

  return { kind: 'different', score: 0, reasons: [] };
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return false;
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  }
  return true;
}

/** Plus grand écart absolu entre deux encombrements, en mm. Null si inconnu. */
function bboxDelta(
  a: [number, number, number] | null,
  b: [number, number, number] | null,
): number | null {
  if (!a || !b) return null;
  return Math.max(...[0, 1, 2].map(i => Math.abs(a[i] - b[i])));
}

/** Plus grand écart relatif entre deux encombrements. Null si inconnu. */
function relativeBboxGap(
  a: [number, number, number] | null,
  b: [number, number, number] | null,
): number | null {
  if (!a || !b) return null;
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    const scale = Math.max(Math.abs(a[i]), Math.abs(b[i]));
    if (scale === 0) continue;
    worst = Math.max(worst, Math.abs(a[i] - b[i]) / scale);
  }
  return worst;
}
