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
  computeLinePrice,
  matchMaterial,
  parseBbox2dMm,
  parseBboxMm,
  parseQuantity,
} from '../src/services/costEngine';
import { ChiffrageLine } from '../src/types';

let passed = 0;
let failed = 0;

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
assert(
  bride.unitPrice > rien.unitPrice * 3,
  `une bride de 200 × 150 coûte bien plus que le repli 100 × 60 (${bride.unitPrice} vs ${rien.unitPrice})`,
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

console.log(`\n─── ${passed} passés, ${failed} échoués ───\n`);
