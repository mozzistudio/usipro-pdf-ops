import { ChiffrageLine } from '../types';

/**
 * Le moteur de coût.
 *
 * Ce qu'il est : une chaîne de calcul **déterministe**. Mêmes entrées, mêmes
 * paramètres, même prix — au centime, à chaque fois. C'est la condition posée
 * par le catalogue des cas produits : le modèle extrait les caractéristiques,
 * il ne produit jamais le prix.
 *
 * Ce qu'il n'est pas : une vérité. Les valeurs par défaut sont des hypothèses
 * de marché — taux horaire d'usinage PME, courbe d'apprentissage usuelle,
 * tarifs matière au kilo. Elles existent pour qu'un prix soit affichable dès
 * le premier jour et corrigeable par l'atelier, pas pour faire autorité. Tout
 * ce qui est supposé est dit dans le bordereau, poste par poste.
 */

export interface PricingSettings {
  currency: string;
  hourlyRate: number;
  setupMinutes: number;
  /** Programmation CAO d'une pièce simple, en minutes. Amortie sur la série. */
  programmingMinutes: number;
  /** Programmation d'une pièce très complexe. Plafond, jamais dépassé. */
  programmingMinutesMax: number;
  minutesPerDm3: number;
  removalRatio: number;
  learningCurve: number;
  marginPct: number;
  handlingMinutesPerPart: number;
  /** Courses de la plus grande fraiseuse de l'atelier, en millimètres. */
  millingTravelXMm: number;
  millingTravelYMm: number;
  millingTravelZMm: number;
  /** Au-delà de cette épaisseur, la pièce n'est plus une tôle. */
  sheetMaxThicknessMm: number;
  /** En deçà de ce format, une pièce mince reste une pièce fraisée ordinaire. */
  sheetMinFormatMm: number;
  /** Part de matière enlevée sur un débit tôle : on ne fraise pas les deux faces. */
  sheetRemovalRatio: number;
  /** Prix d'un alu rectifié, en multiple de l'alu brut. */
  groundAluminiumFactor: number;
  /** Prix d'un inox rectifié, en multiple de l'inox brut. */
  groundInoxFactor: number;
}

export interface MaterialRate {
  id: string;
  label: string;
  aliases: string[];
  pricePerKg: number;
  density: number;
}

/** Une ligne du bordereau : ce qui a été compté, et sur quelle base. */
export interface PriceLineItem {
  label: string;
  amount: number;
  /** D'où vient ce montant, en clair. Un poste sans explication est un poste indéfendable. */
  basis: string;
}

export interface PriceResult {
  unitPrice: number;
  totalPrice: number;
  quantity: number;
  currency: string;
  items: PriceLineItem[];
  /** Ce que le moteur a dû supposer faute de donnée. Affiché tel quel. */
  assumptions: string[];
  /**
   * Masse du brut englobant, en kg. Déjà écrite dans la base du poste matière,
   * mais en toutes lettres : la sortir ici permet de la mettre en colonne dans
   * un tableau sans relire une phrase à la regex.
   */
  rawMassKg: number;
  /** Temps d'usinage par pièce, en minutes, dégressivité de série comprise. */
  unitMinutes: number;
  /**
   * La gamme retenue. Ce n'est pas une décoration : c'est elle qui décide de
   * la matière enlevée, donc du temps, donc du prix.
   */
  route: MachiningRoute;
  /**
   * Ce que l'atelier doit regarder avant de s'engager — hors courses machine,
   * cinquième axe demandé. Distinct des hypothèses : une hypothèse dit ce
   * qu'on a supposé faute de donnée, un constat dit ce qui ne passe pas.
   */
  findings: Finding[];
}

/**
 * La gamme d'une pièce.
 *
 * `debit_tole` n'est pas du fraisage au rabais : une tôle fine et large part
 * en débit, on ne reprend pas les deux faces, et la facturer comme un bloc
 * fraisé multipliait son prix par cinq.
 */
export type MachiningRoute = 'fraisage' | 'tournage' | 'debit_tole';

export interface Finding {
  message: string;
  /** rouge : la pièce ne passe pas en l'état. jaune : à confirmer. */
  level: 'jaune' | 'rouge';
}

/**
 * L'atelier tel qu'il est paramétré : ses taux, ses machines, ses techniques.
 *
 * Le moteur reste pur — il ne lit aucune base. On lui passe le parc, il en
 * tire trois choses : à quel taux facturer la gamme retenue, quelle machine
 * peut recevoir la pièce, et quelle technique l'atelier ne sait pas honorer.
 * Absent, il retombe sur les valeurs de `PricingSettings`, ce qui est
 * exactement l'ancien comportement.
 */
export type RateScope = 'tournage' | 'fraisage_3' | 'fraisage_5' | 'debit_tole' | 'reglage' | 'autre';

export interface ShopRate {
  label: string;
  ratePerHour: number;
  /** La gamme à laquelle ce taux se rattache. 'autre' ne sert aucun calcul. */
  appliesTo: RateScope;
}

export interface ShopMachine {
  label: string;
  kind: 'fraisage' | 'tournage' | 'autre';
  axes: number | null;
  travelXMm: number | null;
  travelYMm: number | null;
  travelZMm: number | null;
  maxDiameterMm: number | null;
  maxLengthMm: number | null;
  count: number;
}

export interface ShopTechnique {
  id: string;
  label: string;
  /** interne : faite ici. sous_traitee : achetée. non : hors du champ. */
  status: 'interne' | 'sous_traitee' | 'non';
}

export interface Shop {
  rates: ShopRate[];
  machines: ShopMachine[];
  techniques: ShopTechnique[];
}

/**
 * Le taux d'une opération, ou le taux unique du moteur à défaut.
 *
 * Un taux manquant ne doit jamais faire un prix à zéro : sans ligne pour la
 * gamme, on reprend `hourlyRate` et le bordereau dira lequel a servi.
 */
function rateFor(scope: RateScope, shop: Shop | undefined, fallback: number): { value: number; label: string | null } {
  const found = shop?.rates.find(r => r.appliesTo === scope && Number.isFinite(r.ratePerHour) && r.ratePerHour > 0);
  return found ? { value: found.ratePerHour, label: found.label } : { value: fallback, label: null };
}

/** La gamme retenue, traduite en portée de taux. */
function scopeOfRoute(route: MachiningRoute, shop: Shop | undefined): RateScope {
  if (route === 'tournage') return 'tournage';
  if (route === 'debit_tole') {
    const sheet = shop?.rates.some(r => r.appliesTo === 'debit_tole');
    return sheet ? 'debit_tole' : 'fraisage_3';
  }
  return 'fraisage_3';
}

/**
 * La plus grande fraiseuse du parc, et ses courses telles qu'elles sont
 * écrites. Le parc prime sur les colonnes de `PricingSettings` : celles-ci
 * décrivaient une machine que personne ne pouvait nommer, et un constat de
 * hors-courses se rend à l'atelier en nommant la machine.
 */
function biggestMill(
  shop: Shop | undefined,
  settings: PricingSettings,
): { travels: number[]; label: string | null } {
  const mills = (shop?.machines ?? []).filter(
    m => m.kind === 'fraisage'
      && [m.travelXMm, m.travelYMm, m.travelZMm].every(v => Number.isFinite(Number(v)) && Number(v) > 0),
  );
  if (mills.length === 0) {
    return {
      travels: [settings.millingTravelXMm, settings.millingTravelYMm, settings.millingTravelZMm],
      label: null,
    };
  }

  // La plus grande machine, pas le meilleur de chaque colonne : une pièce
  // entre dans UNE machine, jamais dans la réunion imaginaire de trois.
  let best = mills[0];
  let bestVolume = 0;
  for (const m of mills) {
    const volume = Number(m.travelXMm) * Number(m.travelYMm) * Number(m.travelZMm);
    if (volume > bestVolume) {
      bestVolume = volume;
      best = m;
    }
  }
  return {
    travels: [Number(best.travelXMm), Number(best.travelYMm), Number(best.travelZMm)],
    label: best.label,
  };
}

/** Le tour au plus grand passage, quand le parc en déclare un. */
function biggestLathe(shop: Shop | undefined): { diameter: number; label: string | null } | null {
  const lathes = (shop?.machines ?? []).filter(
    m => m.kind === 'tournage' && Number.isFinite(Number(m.maxDiameterMm)) && Number(m.maxDiameterMm) > 0,
  );
  if (lathes.length === 0) return null;

  let best = lathes[0];
  for (const m of lathes) {
    if (Number(m.maxDiameterMm) > Number(best.maxDiameterMm)) best = m;
  }
  return { diameter: Number(best.maxDiameterMm), label: best.label };
}

export const DEFAULT_SETTINGS: PricingSettings = {
  currency: 'EUR',
  hourlyRate: 75,
  setupMinutes: 45,
  programmingMinutes: 60,
  programmingMinutesMax: 120,
  minutesPerDm3: 25,
  removalRatio: 0.45,
  learningCurve: 0.9,
  marginPct: 20,
  handlingMinutesPerPart: 3,
  // Les courses du Haas VF4, la plus grande des trois machines de l'atelier.
  millingTravelXMm: 1250,
  millingTravelYMm: 500,
  millingTravelZMm: 635,
  sheetMaxThicknessMm: 20,
  sheetMinFormatMm: 250,
  sheetRemovalRatio: 0.12,
  groundAluminiumFactor: 3,
  groundInoxFactor: 1.5,
};

/**
 * Un nombre de cote, sa tolérance ignorée: sur un plan, « 200 ±0.1 » est une
 * cote de 200, et la tolérance ne change pas le volume de brut à commander.
 */
const NUM = '(\\d+(?:\\.\\d+)?)(?:\\s*[±+]\\s*[\\d.]+)?';

/**
 * Bornes de plausibilité d'une cote d'encombrement, en millimètres.
 *
 * En dessous, on lit un chanfrein, un rayon ou une tolérance; au-dessus, un
 * numéro de série ou une référence. Ni l'un ni l'autre n'est la taille de la
 * pièce, et les confondre produit un prix absurde dans un sens ou dans l'autre.
 */
const MIN_DIM_MM = 5;
const MAX_DIM_MM = 3000;

/** Épaisseur supposée quand le plan ne donne que deux côtés. */
const DEFAULT_THICKNESS_MM = 30;

/** Encombrement par défaut quand la demande n'en donne aucun : 100 × 60 × 30 mm. */
const DEFAULT_BBOX_MM: [number, number, number] = [100, 60, 30];
const DEFAULT_QUANTITY = 1;

/**
 * Lit une quantité écrite par un humain.
 *
 * Les vraies demandes écrivent « 32 pièces par livraison / 32 annuelles »,
 * « 10 + option 40 », « selon PJ ». On prend le PREMIER nombre : c'est la
 * quantité de la commande en cours, celle qui doit être chiffrée. Le reste est
 * une information commerciale, pas une quantité à additionner.
 */
export function parseQuantity(raw: string): number | null {
  const match = (raw || '').replace(/\s/g, '').match(/\d+([.,]\d+)?/);
  if (!match) return null;
  const value = Number(match[0].replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * Lit un encombrement « 419.3 x 228.4 x 32 mm » où qu'il soit écrit.
 * Retourne les côtés en millimètres, ou null si la demande n'en donne pas.
 */
export function parseBboxMm(raw: string): [number, number, number] | null {
  // Toutes les virgules décimales, pas la première: un client français écrit
  // « 419,3 x 228,4 x 32 », et n'en convertir qu'une faisait échouer la lecture
  // entière — l'encombrement passait pour absent alors qu'il était écrit.
  const text = (raw || '').replace(/,/g, '.');
  const match = text.match(
    new RegExp(`${NUM}\\s*[x×*]\\s*${NUM}\\s*[x×*]\\s*${NUM}`, 'i'),
  );
  if (!match) return null;
  const dims = [Number(match[1]), Number(match[2]), Number(match[3])];
  return dims.every(d => Number.isFinite(d) && d > 0) ? (dims as [number, number, number]) : null;
}

/**
 * Deux côtés seulement — le cas d'un plan de pièce plate.
 *
 * Un cartouche donne très souvent la longueur et la largeur, l'épaisseur
 * restant dans une vue de coupe qu'aucun extracteur ne lit. Supposer la seule
 * épaisseur vaut infiniment mieux que supposer les trois côtes: sur une bride
 * de 200 × 150, le repli générique se trompait d'un facteur dix sur le volume,
 * donc sur la matière et sur le temps d'usinage.
 */
export function parseBbox2dMm(raw: string): [number, number] | null {
  const text = (raw || '').replace(/,/g, '.');
  const re = new RegExp(`${NUM}\\s*[x×*]\\s*${NUM}`, 'gi');

  // Tous les couples, pas le premier. Un commentaire d'usinage en contient
  // plusieurs — « CH 0.5x0.5 » pour un chanfrein, « 200 x 150 » pour la pièce —
  // et prendre le premier venu avait chiffré une vis à 2,23 € sur la cote de
  // son chanfrein. On retient le plus grand, qui est le seul candidat
  // plausible pour un encombrement.
  let best: [number, number] | null = null;
  let bestArea = 0;

  for (const match of text.matchAll(re)) {
    const dims = [Number(match[1]), Number(match[2])];
    if (!dims.every(d => Number.isFinite(d) && d >= MIN_DIM_MM && d <= MAX_DIM_MM)) continue;

    // « 12 x 5 pièces » n'est pas une cote, c'est un décompte.
    const after = text.slice(match.index + match[0].length);
    if (/^\s*(pi[eè]ces?|pcs|ex|u)\b/i.test(after)) continue;

    const area = dims[0] * dims[1];
    if (area > bestArea) {
      bestArea = area;
      best = dims as [number, number];
    }
  }

  return best;
}

/**
 * La pièce est-elle tournée ?
 *
 * L'atelier ne demande pas de signaler l'encombrement en tournage : la barre
 * passe, ou elle ne passe pas, et ce n'est pas la même question que les
 * courses d'une fraiseuse. On lit donc la gamme dans ce que la demande dit de
 * la pièce — son nom suffit presque toujours, un diamètre le confirme.
 */
export function isTurned(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (/\b(tournage|tourn[ée]e?s?|au tour)\b/.test(t)) return true;
  return /\b(vis|axes?|arbres?|bagues?|douilles?|goujons?|entretoises?|rondelles?|[ée]crous?|bouchons?|embouts?|pions?|broches?|tiges?)\b/.test(t);
}

/**
 * La pièce demande-t-elle une face de référence ?
 *
 * Une perpendicularité stricte ou un état de surface ne se rattrape pas au
 * fraisage sur une tôle brute : l'atelier part alors d'un plat déjà rectifié,
 * qui coûte trois fois l'alu ordinaire. La règle ne s'invente pas, elle est
 * écrite sur le plan — on la lit, on ne la devine pas.
 */
export function needsGroundStock(text: string): boolean {
  const t = (text || '').toLowerCase();
  return /perpendicularit[ée]|plan[ée]it[ée]|parall[ée]lisme|rectifi|[ée]tat de surface|\bra\s*[0-9]|\brz\s*[0-9]/.test(t);
}

/**
 * Les marqueurs de complexité d'une pièce, tels que la demande les écrit.
 *
 * La programmation va d'une heure à deux : il faut donc une échelle, et elle
 * doit être vérifiable. Chaque marqueur trouvé est nommé dans le bordereau —
 * l'opérateur voit sur quoi la machine s'est appuyée pour compter deux heures
 * plutôt qu'une, et peut la contredire.
 */
const COMPLEXITY_MARKERS: Array<[RegExp, string]> = [
  [/moletage/i, 'moletage'],
  [/filetage|taraudage|taraud[ée]|\bm[0-9]{1,2}\b/i, 'filetage'],
  [/al[ée]sage|\bh[67]\b|\bg[67]\b/i, 'alésage tolérancé'],
  [/rainure|gorge|lamage|fraisure/i, 'rainure ou gorge'],
  [/poche|contre-d[ée]pouille/i, 'poche'],
  [/perpendicularit[ée]|plan[ée]it[ée]|coaxialit[ée]|parall[ée]lisme/i, 'tolérance géométrique'],
  [/[±+]\s*0[.,]0[0-9]/i, 'tolérance serrée'],
  [/[ée]tat de surface|\bra\s*[0-9]|\brz\s*[0-9]|poli|brossé/i, 'état de surface'],
  [/anodis|nickelag|alodine|molycote|traitement|passivation|z[ií]ngage|peinture/i, 'traitement'],
  [/gravure|marquage/i, 'marquage'],
  [/hexagone sur plat|m[ée]plat|six pans/i, 'reprise sur plat'],
];

/**
 * Le temps de programmation d'une pièce, en minutes.
 *
 * Une heure pour une pièce simple, deux au maximum pour une pièce très
 * complexe : c'est l'atelier qui le dit, et le moteur ne fait que répartir
 * l'intervalle sur ce qu'il sait lire. Un quart d'heure par exigence trouvée,
 * plafonné — jamais au-delà de ce que l'atelier a annoncé.
 */
export function programmingEffort(
  text: string,
  settings: PricingSettings,
): { minutes: number; markers: string[] } {
  const markers: string[] = [];
  for (const [pattern, label] of COMPLEXITY_MARKERS) {
    if (pattern.test(text || '')) markers.push(label);
  }
  const span = Math.max(0, settings.programmingMinutesMax - settings.programmingMinutes);
  const step = 15;
  const minutes = Math.min(
    settings.programmingMinutesMax,
    settings.programmingMinutes + Math.min(span, markers.length * step),
  );
  return { minutes, markers };
}

/** Rattache un texte de matière à une nuance tarifée. */
export function matchMaterial(raw: string, rates: MaterialRate[]): MaterialRate {
  const text = (raw || '').toLowerCase();
  const fallback = rates.find(r => r.id === 'inconnu') ?? rates[rates.length - 1];
  if (!text.trim()) return fallback;

  for (const rate of rates) {
    if (rate.id === 'inconnu') continue;
    if (rate.aliases.some(alias => alias && text.includes(alias.toLowerCase()))) return rate;
    if (text.includes(rate.label.toLowerCase())) return rate;
  }
  return fallback;
}

/**
 * Le prix d'une ligne de demande.
 *
 * Structure imposée par le catalogue : `mise en train + unitaire × quantité`,
 * la mise en train amortie sur la quantité, et une dégressivité qui vient de
 * la courbe d'apprentissage — pas d'une remise arbitraire. Deux quantités
 * différentes donnent donc deux prix cohérents entre eux par construction.
 */
export function computeLinePrice(
  line: ChiffrageLine,
  settings: PricingSettings,
  rates: MaterialRate[],
  /** Le parc et les taux de l'atelier. Absent : le moteur s'en tient à `settings`. */
  shop?: Shop,
): PriceResult {
  const assumptions: string[] = [];

  const quantity = parseQuantity(line.quantity) ?? DEFAULT_QUANTITY;
  if (parseQuantity(line.quantity) === null) {
    assumptions.push(`quantité absente de la demande — chiffré pour ${DEFAULT_QUANTITY} pièce`);
  }

  // L'encombrement peut être écrit dans la quantité, le commentaire ou la
  // désignation selon les clients: on le cherche partout avant d'en supposer un.
  const bbox =
    parseBboxMm(line.comment) ?? parseBboxMm(line.designation) ?? parseBboxMm(line.quantity);

  // Trois côtes, puis deux, puis rien: à chaque étage on suppose le moins
  // possible, et on dit exactement ce qu'on a supposé.
  const flat = bbox
    ? null
    : (parseBbox2dMm(line.comment) ??
       parseBbox2dMm(line.designation) ??
       parseBbox2dMm(line.quantity));

  const dims: [number, number, number] = bbox
    ? bbox
    : flat
      ? [flat[0], flat[1], DEFAULT_THICKNESS_MM]
      : DEFAULT_BBOX_MM;

  if (flat) {
    assumptions.push(
      `épaisseur absente du plan — ${flat[0]} × ${flat[1]} mm lus, épaisseur supposée ${DEFAULT_THICKNESS_MM} mm`,
    );
  } else if (!bbox) {
    assumptions.push(
      `encombrement absent — supposé ${DEFAULT_BBOX_MM.join(' × ')} mm, à corriger dès réception du plan`,
    );
  }

  const material = matchMaterial(line.material, rates);
  if (material.id === 'inconnu') {
    assumptions.push(
      line.material?.trim()
        ? `matière « ${line.material} » absente du référentiel — tarif générique appliqué`
        : 'matière non précisée — tarif générique appliqué',
    );
  }

  // Tout ce que la demande dit de la pièce, en un seul texte : la gamme, les
  // exigences et la complexité sont écrites tantôt dans la désignation, tantôt
  // dans le commentaire, et jamais au même endroit d'un client à l'autre.
  const said = [line.designation, line.comment, line.material, line.reference]
    .filter(Boolean).join(' ');

  const findings: Finding[] = [];

  // ── La gamme ────────────────────────────────────────────────────
  //
  // Trois cas seulement, parce que l'atelier n'en a que trois : le tour, la
  // fraiseuse, et le débit tôle. C'est la gamme qui commande la matière
  // enlevée, donc le temps, donc le prix — la choisir avant de compter n'est
  // pas un détail de présentation.
  const turned = isTurned(said);
  const sorted = [...dims].sort((a, b) => b - a);
  const thickness = sorted[2];
  const format = sorted[0];
  const sheet = !turned
    && thickness <= settings.sheetMaxThicknessMm
    && format >= settings.sheetMinFormatMm;
  const route: MachiningRoute = turned ? 'tournage' : sheet ? 'debit_tole' : 'fraisage';

  // ── Les courses de la machine ───────────────────────────────────
  //
  // L'atelier n'a pas de quatrième ni de cinquième axe, et sa plus grande
  // fraiseuse a des courses finies. Une pièce qui n'y entre pas n'est pas
  // « un peu plus chère » : elle est à sous-traiter, et le dire avant le devis
  // vaut mieux que le découvrir en préparation.
  const mill = biggestMill(shop, settings);
  const travels = mill.travels;
  // Comparées de la plus grande à la plus grande: une pièce se pose comme elle
  // entre, et « 400 de large » ne se compare pas à la course en X par principe.
  const ranked = [...travels].sort((a, b) => b - a);
  if (!turned && sorted.some((d, i) => d > ranked[i])) {
    findings.push({
      level: 'rouge',
      message:
        `encombrement ${sorted.map(d => round2(d)).join(' × ')} mm hors courses ` +
        `${mill.label ? `du ${mill.label}` : 'de la fraiseuse'} ` +
        `(${travels.join(' × ')} mm) — pièce à sous-traiter ou à repositionner`,
    });
  }

  // Le tour a lui aussi une limite, et elle ne se lit pas en courses : c'est
  // un diamètre passant. Une barre trop grosse ne se repositionne pas.
  if (turned) {
    const lathe = biggestLathe(shop);
    // Sur une pièce tournée, le diamètre est le plus grand des deux petits
    // côtés du brut — le plus long est la longueur de barre.
    if (lathe && sorted[1] > lathe.diameter) {
      findings.push({
        level: 'rouge',
        message:
          `Ø ${round2(sorted[1])} mm au-delà du passage ${lathe.label ? `du ${lathe.label}` : 'du tour'} ` +
          `(Ø ${round2(lathe.diameter)} mm) — pièce à sous-traiter`,
      });
    }
  }

  // Une demande multi-axes n'est un problème que si l'atelier ne sait pas la
  // faire. Ce n'est plus écrit en dur ici : le paramétrage le dit, et le jour
  // où un centre 5 axes entre dans le parc, le constat s'éteint tout seul.
  if (/\b(5\s*axes?|cinq\s*axes?|4\s*axes?|quatre\s*axes?)\b/i.test(said)) {
    const five = shop?.techniques.find(t => t.id === 'fraisage_5');
    if (!five || five.status === 'non') {
      findings.push({
        level: 'jaune',
        message: 'usinage multi-axes évoqué — l\'atelier travaille en 3 axes avec repositionnement',
      });
    } else if (five.status === 'sous_traitee') {
      findings.push({
        level: 'jaune',
        message: 'usinage multi-axes évoqué — opération sous-traitée, délai et prix à confirmer',
      });
    }
  }

  // ── La matière ──────────────────────────────────────────────────
  const rawVolumeDm3 = (dims[0] * dims[1] * dims[2]) / 1_000_000;
  const rawMassKg = rawVolumeDm3 * material.density;

  // Une face de référence ne se fraise pas sur du brut : on part d'un plat
  // déjà rectifié, et il se paie. Le surcoût dépend de la nuance, l'atelier a
  // donné les deux qu'il achète; pour les autres, on ne l'invente pas.
  const ground = needsGroundStock(said);
  const groundFactor = !ground
    ? 1
    : material.id === 'aluminium'
      ? settings.groundAluminiumFactor
      : material.id === 'inox'
        ? settings.groundInoxFactor
        : 1;
  if (ground && groundFactor === 1) {
    assumptions.push(
      `exigence de planéité ou d'état de surface sur ${material.label} — ` +
      'surcoût de matière rectifiée non tarifé pour cette nuance',
    );
  }

  const pricePerKg = material.pricePerKg * groundFactor;
  const materialCost = rawMassKg * pricePerKg;

  // ── Le temps d'usinage ──────────────────────────────────────────
  //
  // Sur un débit tôle, on ne reprend pas les deux faces : la part de matière
  // enlevée n'a rien à voir avec celle d'un bloc fraisé, et appliquer la même
  // aurait facturé un contour de tôle comme une poche de 40 mm.
  const removalRatio = sheet ? settings.sheetRemovalRatio : settings.removalRatio;
  const removedDm3 = rawVolumeDm3 * removalRatio;
  const machiningMinutes = removedDm3 * settings.minutesPerDm3 + settings.handlingMinutesPerPart;

  // Courbe d'apprentissage: le temps unitaire moyen décroît avec la série.
  const exponent = Math.log(settings.learningCurve) / Math.log(2);
  const averageFactor = quantity > 1 ? Math.pow(quantity, exponent) : 1;
  // Le taux de la gamme retenue : un tour et un centre 5 axes ne se facturent
  // pas pareil, et c'est l'atelier qui écrit ses taux, pas le moteur. Sans
  // taux paramétré pour cette gamme, on reprend le taux unique — le bordereau
  // dira lequel a servi.
  const machiningRate = rateFor(scopeOfRoute(route, shop), shop, settings.hourlyRate);
  const machiningCostPerPart = (machiningMinutes / 60) * machiningRate.value * averageFactor;

  // Mise en train et programmation ne se passent pas sur la machine qui coupe.
  // Un réglage facturé au taux du 5 axes payait une broche à l'arrêt.
  const setupRate = rateFor('reglage', shop, settings.hourlyRate);

  // Mise en train: payée une fois, amortie sur la série.
  const setupCost = (settings.setupMinutes / 60) * setupRate.value;
  const setupPerPart = setupCost / quantity;

  // Programmation CAO: payée une fois elle aussi, mais elle n'est pas la mise
  // en train — une pièce reprogrammée à l'identique ne se remonte pas, et une
  // pièce simple montée trois fois ne se reprogramme pas.
  const programming = programmingEffort(said, settings);
  const programmingCost = (programming.minutes / 60) * setupRate.value;
  const programmingPerPart = programmingCost / quantity;

  const costPerPart = materialCost + machiningCostPerPart + setupPerPart + programmingPerPart;
  const margin = costPerPart * (settings.marginPct / 100);
  const unitPrice = round2(costPerPart + margin);
  const totalPrice = round2(unitPrice * quantity);

  const items: PriceLineItem[] = [
    {
      label: 'Matière',
      amount: round2(materialCost),
      basis:
        `${material.label}${ground && groundFactor > 1 ? ' rectifié' : ''} — brut ` +
        `${dims.map(d => round2(d)).join(' × ')} mm, ` +
        `${round2(rawMassKg)} kg à ${round2(pricePerKg)} €/kg` +
        (groundFactor > 1 ? ` (×${groundFactor} : plat rectifié, face de référence exigée)` : ''),
    },
    {
      label: 'Usinage',
      amount: round2(machiningCostPerPart),
      basis:
        (sheet ? 'débit tôle — une seule face reprise · ' : '') +
        `${round2(removedDm3)} dm³ enlevés à ${settings.minutesPerDm3} min/dm³ ` +
        `+ ${settings.handlingMinutesPerPart} min de reprise, soit ${round2(machiningMinutes)} min ` +
        `à ${machiningRate.value} €/h${machiningRate.label ? ` (${machiningRate.label})` : ''}` +
        (quantity > 1
          ? ` · dégressivité série ×${round2(averageFactor)} (courbe ${settings.learningCurve})`
          : ''),
    },
    {
      label: 'Programmation amortie',
      amount: round2(programmingPerPart),
      basis:
        `${programming.minutes} min de CAO à ${setupRate.value} €/h` +
        `${setupRate.label ? ` (${setupRate.label})` : ''}, réparties sur ` +
        `${quantity} pièce${quantity > 1 ? 's' : ''}` +
        (programming.markers.length
          ? ` · ${programming.markers.join(', ')}`
          : ' · pièce simple'),
    },
    {
      label: 'Mise en train amortie',
      amount: round2(setupPerPart),
      basis:
        `${settings.setupMinutes} min à ${setupRate.value} €/h` +
        `${setupRate.label ? ` (${setupRate.label})` : ''}, réparties sur ${quantity} pièce${quantity > 1 ? 's' : ''}`,
    },
    {
      label: `Marge ${settings.marginPct} %`,
      amount: round2(margin),
      basis: 'appliquée au coût de revient',
    },
  ];

  return {
    unitPrice,
    totalPrice,
    quantity,
    currency: settings.currency,
    items,
    assumptions,
    rawMassKg: round2(rawMassKg),
    unitMinutes: round2(machiningMinutes * averageFactor),
    route,
    findings,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
