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
  minutesPerDm3: number;
  removalRatio: number;
  learningCurve: number;
  marginPct: number;
  handlingMinutesPerPart: number;
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
}

export const DEFAULT_SETTINGS: PricingSettings = {
  currency: 'EUR',
  hourlyRate: 65,
  setupMinutes: 45,
  minutesPerDm3: 25,
  removalRatio: 0.45,
  learningCurve: 0.9,
  marginPct: 20,
  handlingMinutesPerPart: 3,
};

/**
 * Un nombre de cote, sa tolérance ignorée: sur un plan, « 200 ±0.1 » est une
 * cote de 200, et la tolérance ne change pas le volume de brut à commander.
 */
const NUM = '(\\d+(?:\\.\\d+)?)(?:\\s*[±+]\\s*[\\d.]+)?';

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
  const match = text.match(new RegExp(`${NUM}\\s*[x×*]\\s*${NUM}`, 'i'));
  if (!match) return null;

  const dims = [Number(match[1]), Number(match[2])];
  if (!dims.every(d => Number.isFinite(d) && d > 0)) return null;

  // « 12 x 5 pièces » n'est pas une cote. Une dimension de pièce usinée fait au
  // moins un millimètre de côté et ne se lit pas comme un décompte.
  if (/^\s*(pi[eè]ces?|pcs|ex|u)\b/i.test(text.slice(match.index! + match[0].length))) return null;
  return dims as [number, number];
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

  // Volume du brut englobant, en dm³.
  const rawVolumeDm3 = (dims[0] * dims[1] * dims[2]) / 1_000_000;
  const rawMassKg = rawVolumeDm3 * material.density;
  const materialCost = rawMassKg * material.pricePerKg;

  // Temps d'usinage: proportionnel à la matière réellement enlevée.
  const removedDm3 = rawVolumeDm3 * settings.removalRatio;
  const machiningMinutes = removedDm3 * settings.minutesPerDm3 + settings.handlingMinutesPerPart;

  // Courbe d'apprentissage: le temps unitaire moyen décroît avec la série.
  const exponent = Math.log(settings.learningCurve) / Math.log(2);
  const averageFactor = quantity > 1 ? Math.pow(quantity, exponent) : 1;
  const machiningCostPerPart = (machiningMinutes / 60) * settings.hourlyRate * averageFactor;

  // Mise en train: payée une fois, amortie sur la série.
  const setupCost = (settings.setupMinutes / 60) * settings.hourlyRate;
  const setupPerPart = setupCost / quantity;

  const costPerPart = materialCost + machiningCostPerPart + setupPerPart;
  const margin = costPerPart * (settings.marginPct / 100);
  const unitPrice = round2(costPerPart + margin);
  const totalPrice = round2(unitPrice * quantity);

  const items: PriceLineItem[] = [
    {
      label: 'Matière',
      amount: round2(materialCost),
      basis:
        `${material.label} — brut ${dims.map(d => round2(d)).join(' × ')} mm, ` +
        `${round2(rawMassKg)} kg à ${material.pricePerKg} €/kg`,
    },
    {
      label: 'Usinage',
      amount: round2(machiningCostPerPart),
      basis:
        `${round2(removedDm3)} dm³ enlevés à ${settings.minutesPerDm3} min/dm³ ` +
        `+ ${settings.handlingMinutesPerPart} min de reprise, soit ${round2(machiningMinutes)} min ` +
        `à ${settings.hourlyRate} €/h` +
        (quantity > 1
          ? ` · dégressivité série ×${round2(averageFactor)} (courbe ${settings.learningCurve})`
          : ''),
    },
    {
      label: 'Mise en train amortie',
      amount: round2(setupPerPart),
      basis: `${settings.setupMinutes} min à ${settings.hourlyRate} €/h, réparties sur ${quantity} pièce${quantity > 1 ? 's' : ''}`,
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
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
