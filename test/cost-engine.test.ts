/**
 * Le moteur de coût.
 *
 * Ce que le catalogue exige et que ces tests vérifient : deux fois les mêmes
 * caractéristiques donnent deux fois le même prix, la dégressivité vient de la
 * structure de coût et non d'une remise arbitraire, et tout ce que le moteur a
 * dû supposer est dit — un prix posé sur une hypothèse muette est indéfendable.
 *
 * Run: npx ts-node test/cost-engine.test.ts
 */

import {
  DEFAULT_SETTINGS,
  MaterialRate,
  Shop,
  computeLinePrice,
  matchMaterial,
  parseBbox2dMm,
  parseBboxMm,
  parseQuantity,
} from '../src/services/costEngine';
import { ChiffrageLine } from '../src/types';

let passed = 0;
let failed = 0;

const round = (v: number) => Math.round(v * 100) / 100;

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

const RATES: MaterialRate[] = [
  { id: 'aluminium', label: 'Aluminium', aliases: ['alu', 'aluminium', '6061'], pricePerKg: 6.5, density: 2.7 },
  { id: 'titane', label: 'Titane', aliases: ['titane', 'ta6v'], pricePerKg: 60, density: 4.51 },
  { id: 'inconnu', label: 'Matière non identifiée', aliases: [], pricePerKg: 8, density: 7.85 },
];

function line(over: Partial<ChiffrageLine> = {}): ChiffrageLine {
  return {
    reference: '',
    designation: 'Boitier',
    material: 'Aluminium',
    quantity: '32 pièces par livraison / 32 pièces annuelles',
    comment: 'Encombrement : 419.3 x 228.4 x 32 mm',
    ...over,
  };
}

console.log('\n─── Lecture de ce que le client a écrit ────────────────────');

assert(parseQuantity('32 pièces par livraison / 32 annuelles') === 32, 'la première quantité est celle de la commande');
assert(parseQuantity('10 + option 40') === 10, "l'option n'est pas additionnée à la commande");
assert(parseQuantity('selon PJ') === null, 'une quantité non chiffrée reste inconnue');

const bbox = parseBboxMm('Encombrement : 419.3 x 228.4 x 32 mm');
assert(!!bbox && bbox[0] === 419.3 && bbox[2] === 32, `encombrement lu (obtenu ${JSON.stringify(bbox)})`);
assert(parseBboxMm('pas de cote ici') === null, 'aucun encombrement inventé');

assert(matchMaterial('Aluminium 6061', RATES).id === 'aluminium', 'nuance reconnue par alias');
assert(matchMaterial('40CrMnMoS8-6', RATES).id === 'inconnu', 'nuance inconnue → tarif générique, pas de choix au hasard');

console.log('\n─── Les cotes telles que les clients les écrivent ───────────');

const fr = parseBboxMm('Encombrement : 419,3 x 228,4 x 32 mm');
assert(
  !!fr && fr[0] === 419.3 && fr[1] === 228.4 && fr[2] === 32,
  `virgules décimales françaises lues (obtenu ${JSON.stringify(fr)})`,
);

const tol = parseBboxMm('200 ±0,1 x 150 x 25');
assert(
  !!tol && tol[0] === 200 && tol[1] === 150,
  `une tolérance ne casse pas la lecture de la cote (obtenu ${JSON.stringify(tol)})`,
);

const plat = parseBbox2dMm('Plan: 200 ±0,1 x 150, alésage Ø70 H7');
assert(!!plat && plat[0] === 200 && plat[1] === 150, `deux côtés lus (obtenu ${JSON.stringify(plat)})`);
assert(parseBbox2dMm('lot de 12 x 5 pièces') === null, "un décompte n'est pas une cote");
assert(parseBbox2dMm('aucune cote ici') === null, 'aucune cote inventée');

assert(
  parseBbox2dMm('Casser les arêtes vives CH 0.5x0.5 ; point de centre accepté') === null,
  "un chanfrein n'est pas un encombrement",
);
assert(
  JSON.stringify(parseBbox2dMm('CH 0.5x0.5 ; brut 200 x 150 ; congé R2x2')) === '[200,150]',
  'entre plusieurs couples de cotes, le plus grand est retenu',
);

console.log('\n─── Supposer le moins possible ─────────────────────────────');

const bride = computeLinePrice(
  { reference: 'PH-4402', designation: 'Bride', material: 'Aluminium', quantity: '24', comment: '200 x 150' },
  DEFAULT_SETTINGS,
  RATES,
);
const rien = computeLinePrice(
  { reference: 'PH-4402', designation: 'Bride', material: 'Aluminium', quantity: '24', comment: '' },
  DEFAULT_SETTINGS,
  RATES,
);
assert(
  bride.assumptions.length === 1 && bride.assumptions[0].includes('épaisseur'),
  `deux côtés connus: seule l'épaisseur est supposée (obtenu ${JSON.stringify(bride.assumptions)})`,
);
assert(
  rien.assumptions[0].includes('encombrement absent'),
  'sans aucune cote, le repli générique reste annoncé',
);
/** Ce que les postes proportionnels à la pièce pèsent, sans les frais fixes. */
function variable(result: { items: Array<{ label: string; amount: number }> }): number {
  return result.items
    .filter(i => i.label === 'Matière' || i.label === 'Usinage')
    .reduce((sum, i) => sum + i.amount, 0);
}

// Sur les seuls postes que la taille commande. La programmation et la mise en
// train tombent à l'identique sur les deux pièces: les garder dans la
// comparaison mesurerait le forfait, pas la cote lue.
assert(
  variable(bride) > variable(rien) * 3,
  `une bride de 200 × 150 coûte bien plus que le repli 100 × 60 (${round(variable(bride))} vs ${round(variable(rien))} sur matière + usinage)`,
);

console.log('\n─── Déterminisme ───────────────────────────────────────────');

const a = computeLinePrice(line(), DEFAULT_SETTINGS, RATES);
const b = computeLinePrice(line(), DEFAULT_SETTINGS, RATES);
assert(a.unitPrice === b.unitPrice && a.totalPrice === b.totalPrice, 'mêmes entrées, même prix au centime');
assert(a.quantity === 32, 'la quantité retenue est celle du mail');

console.log('\n─── Le bordereau explique le prix ──────────────────────────');

const sum = a.items.reduce((acc, i) => acc + i.amount, 0);
assert(Math.abs(sum - a.unitPrice) < 0.05, `les postes font le prix unitaire (${sum.toFixed(2)} vs ${a.unitPrice})`);
assert(a.items.every(i => i.basis.trim().length > 0), 'chaque poste dit sur quelle base il est calculé');
assert(
  a.items.some(i => i.label === 'Matière' && i.basis.includes('kg')),
  'le poste matière donne la masse et le tarif au kilo',
);
assert(Math.abs(a.totalPrice - a.unitPrice * a.quantity) < 0.05, 'total = unitaire × quantité');

console.log('\n─── Dégressivité ───────────────────────────────────────────');

const un = computeLinePrice(line({ quantity: '1' }), DEFAULT_SETTINGS, RATES);
const cent = computeLinePrice(line({ quantity: '100' }), DEFAULT_SETTINGS, RATES);
assert(cent.unitPrice < un.unitPrice, 'le prix unitaire baisse avec la quantité');
assert(cent.totalPrice > un.totalPrice, 'le total, lui, monte — la dégressivité ne fait pas travailler à perte');

const setupUn = un.items.find(i => i.label.startsWith('Mise en train'))!.amount;
const setupCent = cent.items.find(i => i.label.startsWith('Mise en train'))!.amount;
assert(setupCent < setupUn / 50, 'la mise en train est amortie sur la série, pas répétée');

console.log('\n─── La matière pèse ce qu’elle vaut ────────────────────────');

const titane = computeLinePrice(line({ material: 'Titane TA6V' }), DEFAULT_SETTINGS, RATES);
assert(titane.unitPrice > a.unitPrice * 2, 'le titane coûte nettement plus cher que l’aluminium');

console.log('\n─── Ce qui est supposé est dit ─────────────────────────────');

const nu = computeLinePrice(
  { reference: '', designation: 'Pièce', material: '', quantity: '', comment: '' },
  DEFAULT_SETTINGS,
  RATES,
);
assert(nu.unitPrice > 0, 'un prix est quand même produit');
assert(nu.assumptions.length === 3, `les trois hypothèses sont listées (obtenu ${nu.assumptions.length})`);
assert(
  nu.assumptions.some(x => x.includes('quantité')) &&
    nu.assumptions.some(x => x.includes('encombrement')) &&
    nu.assumptions.some(x => x.includes('matière')),
  'quantité, encombrement et matière manquantes sont nommées une par une',
);
assert(
  a.assumptions.length === 0,
  'une demande complète ne traîne aucune hypothèse',
);

console.log('\n─── Les paramètres commandent ──────────────────────────────');

const cher = computeLinePrice(line(), { ...DEFAULT_SETTINGS, hourlyRate: 130 }, RATES);
assert(cher.unitPrice > a.unitPrice, 'doubler le taux horaire augmente le prix');

const sansMarge = computeLinePrice(line(), { ...DEFAULT_SETTINGS, marginPct: 0 }, RATES);
assert(sansMarge.unitPrice < a.unitPrice, 'retirer la marge baisse le prix');
assert(
  sansMarge.items.find(i => i.label.startsWith('Marge'))!.amount === 0,
  'la marge nulle apparaît quand même au bordereau, à zéro',
);


console.log('\n─── Les règles de l’atelier ────────────────────────────────');

// Les trois machines de l'atelier n'ont pas de quatrième axe et des courses
// finies: une pièce qui n'y entre pas doit être signalée avant le devis, pas
// découverte en préparation.
const horsCourses = computeLinePrice(
  line({ designation: 'Longeron', comment: 'Encombrement : 1600 x 400 x 60 mm' }),
  DEFAULT_SETTINGS,
  RATES,
);
assert(
  horsCourses.findings.some(f => f.level === 'rouge' && f.message.includes('hors courses')),
  `1600 mm de long: hors courses de la fraiseuse, et dit en rouge (obtenu ${JSON.stringify(horsCourses.findings)})`,
);

// En tournage, l'atelier ne demande pas de signaler l'encombrement: la barre
// passe ou ne passe pas, ce n'est pas la question des courses d'une fraiseuse.
const vis = computeLinePrice(
  line({ designation: 'Vis à tête moletée', comment: 'Encombrement : 1600 x 40 x 40 mm' }),
  DEFAULT_SETTINGS,
  RATES,
);
assert(vis.route === 'tournage', `une vis part au tour (obtenu ${vis.route})`);
assert(
  !vis.findings.some(f => f.message.includes('hors courses')),
  'aucun constat de courses sur une pièce tournée',
);

// Une tôle fine et large n'est pas un bloc: on ne fraise pas les deux faces,
// et la facturer comme un bloc multipliait son prix.
const tole = computeLinePrice(
  line({ designation: 'Platine', comment: 'Encombrement : 400 x 300 x 5 mm' }),
  DEFAULT_SETTINGS,
  RATES,
);
const bloc = computeLinePrice(
  line({ designation: 'Platine', comment: 'Encombrement : 400 x 300 x 25 mm' }),
  DEFAULT_SETTINGS,
  RATES,
);
assert(tole.route === 'debit_tole', `une tôle de 5 mm part en débit (obtenu ${tole.route})`);
assert(bloc.route === 'fraisage', `un plat de 25 mm reste fraisé (obtenu ${bloc.route})`);
assert(
  tole.items.find(i => i.label === 'Usinage')!.amount < bloc.items.find(i => i.label === 'Usinage')!.amount,
  'le débit tôle ne se facture pas comme un bloc fraisé',
);

// Une face de référence ne se fraise pas sur du brut: l'atelier part d'un plat
// rectifié, trois fois le prix de l'alu ordinaire.
const rectifie = computeLinePrice(
  line({ designation: 'Plaque', comment: 'Encombrement : 400 x 300 x 5 mm ; perpendicularité 0.02' }),
  DEFAULT_SETTINGS,
  RATES,
);
assert(
  round(rectifie.items[0].amount) === round(tole.items[0].amount * DEFAULT_SETTINGS.groundAluminiumFactor),
  `l'alu rectifié coûte ×${DEFAULT_SETTINGS.groundAluminiumFactor} (obtenu ${rectifie.items[0].amount} vs ${tole.items[0].amount})`,
);
assert(rectifie.items[0].basis.includes('rectifié'), 'le bordereau dit pourquoi la matière a changé de prix');

// La programmation va d'une heure à deux, jamais au-delà, et dit sur quoi elle
// s'est appuyée pour compter deux heures plutôt qu'une.
const simple = computeLinePrice(line({ designation: 'Cale', comment: 'Encombrement : 60 x 40 x 20 mm' }), DEFAULT_SETTINGS, RATES);
const complexe = computeLinePrice(
  line({
    designation: 'Corps de vanne',
    comment: 'Encombrement : 120 x 90 x 60 mm ; moletage, taraudage M8, alésage H7, rainure, ' +
      'perpendicularité 0.02, Ra 0.8, anodisation, gravure, contre-dépouille',
  }),
  DEFAULT_SETTINGS,
  RATES,
);
const prog = (r: typeof simple) => r.items.find(i => i.label === 'Programmation amortie')!;
assert(prog(simple).basis.startsWith(String(DEFAULT_SETTINGS.programmingMinutes) + ' min'), 'une pièce simple: une heure de CAO');
assert(
  prog(complexe).basis.startsWith(String(DEFAULT_SETTINGS.programmingMinutesMax) + ' min'),
  `une pièce très complexe: deux heures, jamais plus (obtenu « ${prog(complexe).basis} »)`,
);
assert(prog(complexe).basis.includes('moletage'), 'le bordereau nomme ce qui a fait monter la programmation');
assert(
  prog(simple).amount * 32 > prog(simple).amount,
  'la programmation est amortie sur la série, pas répétée à la pièce',
);

console.log('\n─── Le paramétrage de l’atelier commande ───────────────────');

/**
 * L'atelier tel qu'il serait paramétré : un tour, un centre, un 5 axes
 * déclaré hors du champ, et des taux qui diffèrent d'une gamme à l'autre.
 */
const ATELIER: Shop = {
  rates: [
    { label: 'Tournage CN', ratePerHour: 62, appliesTo: 'tournage' },
    { label: 'Fraisage 3 axes', ratePerHour: 100, appliesTo: 'fraisage_3' },
    { label: 'Réglage / démarrage', ratePerHour: 40, appliesTo: 'reglage' },
  ],
  machines: [
    {
      label: 'Centre 3 axes', kind: 'fraisage', axes: 3,
      travelXMm: 800, travelYMm: 400, travelZMm: 400,
      maxDiameterMm: null, maxLengthMm: null, count: 2,
    },
    {
      label: 'Tour CN', kind: 'tournage', axes: 2,
      travelXMm: null, travelYMm: null, travelZMm: null,
      maxDiameterMm: 200, maxLengthMm: 500, count: 1,
    },
  ],
  techniques: [
    { id: 'fraisage_3', label: 'Fraisage 3 axes', status: 'interne' },
    { id: 'fraisage_5', label: 'Fraisage 5 axes', status: 'non' },
  ],
};

const sansAtelier = computeLinePrice(line(), DEFAULT_SETTINGS, RATES);
const avecAtelier = computeLinePrice(line(), DEFAULT_SETTINGS, RATES, ATELIER);
const usinage = (r: typeof sansAtelier) => r.items.find(i => i.label === 'Usinage')!;
assert(
  usinage(avecAtelier).basis.includes('100 €/h (Fraisage 3 axes)'),
  `le taux de la gamme sert, et le bordereau le nomme (obtenu « ${usinage(avecAtelier).basis} »)`,
);
assert(
  usinage(sansAtelier).basis.includes(String(DEFAULT_SETTINGS.hourlyRate) + ' €/h'),
  'sans paramétrage, le taux unique sert comme avant',
);

const reglage = avecAtelier.items.find(i => i.label === 'Mise en train amortie')!;
assert(
  reglage.basis.includes('40 €/h (Réglage / démarrage)'),
  `la mise en train se paie au taux du réglage, pas à celui de la broche (obtenu « ${reglage.basis} »)`,
);

// Le parc prime sur les courses de repli : la pièce passait dans la fraiseuse
// supposée par défaut, elle ne passe pas dans celle que l'atelier possède.
const horsParc = computeLinePrice(
  line({ comment: 'Encombrement : 900 x 300 x 60 mm' }),
  DEFAULT_SETTINGS,
  RATES,
  ATELIER,
);
assert(
  horsParc.findings.some(f => f.level === 'rouge' && f.message.includes('Centre 3 axes')),
  `hors courses de la machine du parc, et la machine est nommée (obtenu ${JSON.stringify(horsParc.findings)})`,
);

// Le tour a une limite qui n'est pas une course : un diamètre passant.
const barre = computeLinePrice(
  line({ designation: 'Axe tourné', comment: 'Encombrement : 400 x 260 x 260 mm' }),
  DEFAULT_SETTINGS,
  RATES,
  ATELIER,
);
assert(
  barre.route === 'tournage' && barre.findings.some(f => f.message.includes('au-delà du passage')),
  `un Ø 260 ne passe pas dans un tour de Ø 200 (obtenu ${JSON.stringify(barre.findings)})`,
);

// Ce que l'atelier sait faire n'est plus écrit en dur dans le moteur.
const cinqAxes = line({ comment: 'Encombrement : 100 x 60 x 30 mm ; usinage 5 axes demandé' });
const refuse = computeLinePrice(cinqAxes, DEFAULT_SETTINGS, RATES, ATELIER);
const equipe = computeLinePrice(cinqAxes, DEFAULT_SETTINGS, RATES, {
  ...ATELIER,
  techniques: [{ id: 'fraisage_5', label: 'Fraisage 5 axes', status: 'interne' }],
});
assert(
  refuse.findings.some(f => f.message.includes('multi-axes')),
  'sans 5 axes déclaré, la demande porte un constat',
);
assert(
  !equipe.findings.some(f => f.message.includes('multi-axes')),
  'le jour où l’atelier déclare son 5 axes, le constat s’éteint',
);

console.log(`\n─── ${passed} passés, ${failed} échoués ───\n`);
