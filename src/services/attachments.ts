import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { logger } from '../utils/logger';

/**
 * Lecture des pièces jointes d'une demande de chiffrage.
 *
 * Les vraies demandes reçues sur chiffrage@usi-pro.com mettent l'essentiel
 * ailleurs que dans le corps du mail : un Excel de quantités, un package de
 * plans, des STEP « disponibles sur demande ». Sans lecture des pièces
 * jointes, deux demandes sur trois arrivent vides.
 *
 * Ce module transforme chaque pièce jointe en TEXTE exploitable — rien de
 * plus. L'interprétation reste au modèle, et la géométrie des STEP part vers
 * le rattachement d'articles.
 */

/** Une pièce jointe telle que le pont Gmail la transmet. */
export interface InboundAttachment {
  name: string;
  /** Type MIME annoncé par Gmail, indicatif seulement. */
  contentType?: string;
  size?: number;
  /** Contenu base64, absent quand le pont a jugé le fichier trop lourd. */
  contentBase64?: string | null;
  /** Pourquoi le contenu manque, le cas échéant. */
  skipped?: string | null;
}

export interface ReadAttachment {
  name: string;
  kind: 'tableur' | 'pdf' | 'step' | 'image' | 'archive' | 'autre';
  size: number;
  /** Texte extrait, prêt à être lu par le modèle. Vide si rien d'exploitable. */
  text: string;
  /** Octets du STEP, pour le calcul d'empreinte. Null sinon. */
  stepBytes: Buffer | null;
  /** Octets d'une image, pour l'envoyer au modèle qui, lui, sait la regarder. */
  image: { bytes: Buffer; mediaType: string } | null;
  /** Ce qui empêche de lire ce fichier, en clair pour l'opérateur. */
  note: string | null;
  /** D'où sort ce fichier quand il vient d'une archive. */
  fromArchive?: string;
}

/** Au-delà, le texte d'une pièce jointe est tronqué avant d'entrer dans un prompt. */
const MAX_TEXT_PER_FILE = 12000;
/** Bornes d'ouverture d'une archive: un zip de plans reste raisonnable, un zip de sauvegarde non. */
const MAX_ARCHIVE_ENTRIES = 60;
const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;

/** Au-delà, l'API refuse l'image. On le dit plutôt que de laisser l'appel échouer. */
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

/** Les seuls formats d'image que le modèle sait regarder. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp',
};

function ext(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

function imageMediaType(name: string): string | null {
  return IMAGE_MEDIA_TYPES[ext(name)] ?? null;
}

/** Un tableur peut contenir des milliers de lignes de tableau de bord: on borne. */
const MAX_SHEET_ROWS = 400;

export function classify(name: string, contentType?: string): ReadAttachment['kind'] {
  const lower = name.toLowerCase();
  if (/\.(xlsx|xlsm|xls|csv|tsv)$/.test(lower)) return 'tableur';
  if (/\.pdf$/.test(lower)) return 'pdf';
  if (/\.(stp|step)$/.test(lower)) return 'step';
  if (/\.zip$/.test(lower)) return 'archive';
  if (/\.(png|jpe?g|gif|webp|bmp|heic)$/.test(lower)) return 'image';
  if (contentType?.startsWith('image/')) return 'image';
  return 'autre';
}

/**
 * Lit une pièce jointe. Ne lève jamais : un fichier illisible devient une note
 * affichée à l'opérateur, pas une demande perdue.
 */
export async function readAttachment(att: InboundAttachment): Promise<ReadAttachment> {
  const kind = classify(att.name, att.contentType);
  const size = att.size ?? 0;
  const base: ReadAttachment = {
    name: att.name, kind, size, text: '', stepBytes: null, image: null, note: null,
  };

  if (!att.contentBase64) {
    return { ...base, note: att.skipped || 'contenu non transmis' };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(att.contentBase64, 'base64');
  } catch {
    return { ...base, note: 'contenu illisible (base64 invalide)' };
  }

  try {
    if (kind === 'tableur') {
      return { ...base, size: bytes.length, text: sheetToText(bytes, att.name) };
    }
    if (kind === 'pdf') {
      const text = await pdfToText(bytes);
      if (text.trim()) return { ...base, size: bytes.length, text };
      // Un PDF sans texte est presque toujours un plan scanné. Le dire permet
      // à l'opérateur de l'ouvrir lui-même plutôt que de chercher pourquoi la
      // pièce n'a pas de matière.
      return {
        ...base,
        size: bytes.length,
        note: 'PDF sans couche texte (scan ?) — à ouvrir à la main',
      };
    }
    if (kind === 'step') {
      // Le texte d'un STEP n'apprend rien au modèle ; sa géométrie, si.
      return { ...base, size: bytes.length, stepBytes: bytes };
    }
    if (kind === 'archive') {
      // L'archive elle-même n'a rien à dire; ce qu'elle contient, si. Elle est
      // ouverte séparément par expandArchive, pour que chaque membre suive le
      // même chemin qu'une pièce jointe ordinaire.
      return { ...base, size: bytes.length, note: 'archive — ouverte, voir son contenu' };
    }
    if (kind === 'image') {
      // Une photo de plan n'a pas de texte à extraire: elle part telle quelle
      // au modèle, qui sait la regarder. Un format que l'API n'accepte pas
      // repart avec sa raison plutôt qu'en silence.
      const mediaType = imageMediaType(att.name);
      if (!mediaType) {
        return { ...base, size: bytes.length, note: `image ${ext(att.name)} — format non lisible par le modèle` };
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        return {
          ...base,
          size: bytes.length,
          note: `image trop lourde (${Math.round(bytes.length / 1024 / 1024)} Mo) — non transmise au modèle`,
        };
      }
      return { ...base, size: bytes.length, image: { bytes, mediaType } };
    }
    return { ...base, size: bytes.length, note: 'format non lu automatiquement' };
  } catch (err: any) {
    logger.warn({ name: att.name, err: err.message }, 'Pièce jointe illisible');
    return { ...base, size: bytes.length, note: `lecture impossible: ${err.message}` };
  }
}

/**
 * Ouvre une archive et lit chacun de ses membres.
 *
 * Un « package de plans » est presque toujours un .zip: une dizaine de PDF,
 * parfois les STEP à côté. S'arrêter au zip revient à ne rien recevoir, alors
 * que tout est là. Les membres repassent par readAttachment, donc un PDF dans
 * un zip est lu exactement comme un PDF joint au mail.
 *
 * Ne lève jamais: une archive illisible ou protégée redevient une note.
 */
export async function expandArchive(
  name: string,
  bytes: Buffer,
): Promise<{ members: Array<{ read: ReadAttachment; bytes: Buffer }>; note: string | null }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err: any) {
    return { members: [], note: `archive illisible: ${err.message}` };
  }

  const entries = Object.values(zip.files).filter(e => !e.dir);
  const kept: Array<{ read: ReadAttachment; bytes: Buffer }> = [];
  let budget = MAX_ARCHIVE_BYTES;
  let skipped = 0;

  for (const entry of entries.slice(0, MAX_ARCHIVE_ENTRIES)) {
    // Les dossiers cachés d'un zip macOS ne sont pas des plans.
    if (/^__MACOSX\/|\/\._|^\._/.test(entry.name)) continue;

    let member: Buffer;
    try {
      member = Buffer.from(await entry.async('nodebuffer'));
    } catch {
      skipped++;
      continue;
    }
    if (member.length > budget) { skipped++; continue; }
    budget -= member.length;

    const base = entry.name.split('/').pop() || entry.name;
    const read = await readAttachment({
      name: base,
      size: member.length,
      contentBase64: member.toString('base64'),
    });
    kept.push({ read: { ...read, fromArchive: name }, bytes: member });
  }

  const extra = entries.length - Math.min(entries.length, MAX_ARCHIVE_ENTRIES) + skipped;
  return {
    members: kept,
    note: extra > 0 ? `${extra} fichier(s) de l'archive non lus (nombre ou poids)` : null,
  };
}

/**
 * Aplati un classeur en texte ligne à ligne.
 *
 * Volontairement brut : les vraies feuilles de demande ont des en-têtes
 * fantaisistes, des lignes vides, des totaux. Normaliser ici reviendrait à
 * décider à la place du modèle ce qui est une ligne de demande.
 */
function sheetToText(bytes: Buffer, name: string): string {
  const book = XLSX.read(bytes, { type: 'buffer' });
  const out: string[] = [];

  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: '' });
    out.push(`--- ${name} / feuille "${sheetName}" ---`);

    for (const row of rows.slice(0, MAX_SHEET_ROWS)) {
      const cells = (row as unknown[]).map(c => String(c ?? '').trim()).filter(Boolean);
      if (cells.length) out.push(cells.join(' | '));
    }
    if (rows.length > MAX_SHEET_ROWS) {
      out.push(`… ${rows.length - MAX_SHEET_ROWS} lignes supplémentaires non transmises`);
    }
  }

  return out.join('\n').slice(0, MAX_TEXT_PER_FILE);
}

/**
 * Le texte d'un PDF, par deux lecteurs plutôt qu'un.
 *
 * pdf2json encaisse des PDF que pdf-parse refuse, et l'inverse est vrai aussi:
 * il rendait une chaîne vide sur des plans parfaitement lisibles, en avalant
 * son erreur. Un plan muet fait chiffrer une pièce sur son nom de fichier,
 * donc on essaie le second avant d'abandonner.
 *
 * Quand les deux échouent, ce n'est pas forcément une panne: un plan scanné
 * n'a pas de couche texte. L'appelant le dit à l'opérateur au lieu de laisser
 * croire que la pièce jointe était vide.
 */
async function pdfToText(bytes: Buffer): Promise<string> {
  const { extractTextFromPdf } = await import('./pdfAnonymizer');
  const first = (await extractTextFromPdf(bytes)) || '';
  if (first.trim()) return first.slice(0, MAX_TEXT_PER_FILE);

  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText();
      return (result.text || '').slice(0, MAX_TEXT_PER_FILE);
    } finally {
      await parser.destroy();
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Second lecteur PDF en échec');
    return '';
  }
}

/**
 * Liens de plateformes de partage trouvés dans un mail.
 *
 * Beaucoup de donneurs d'ordres n'attachent rien : ils déposent les plans sur
 * WeTransfer ou Drive. On ne peut pas les télécharger — ces liens exigent une
 * session, expirent, et suivre une URL reçue par mail serait imprudent. On les
 * remonte donc à l'opérateur, nommément, au lieu de laisser croire que la
 * demande n'a pas de contenu.
 */
const SHARING_HOSTS = [
  'wetransfer.com', 'we.tl',
  'drive.google.com', 'docs.google.com',
  'dropbox.com', 'sharepoint.com', '1drv.ms', 'onedrive.live.com',
  'swisstransfer.com', 'smash.fr', 'fromsmash.com', 'grosfichiers.com',
  'transfernow.net', 'filemail.com', 'box.com', 'mega.nz',
];

export function findSharingLinks(body: string): string[] {
  const urls = body.match(/https?:\/\/[^\s<>()"']+/gi) || [];
  const seen = new Set<string>();

  for (const raw of urls) {
    const url = raw.replace(/[.,;:)]+$/, '');
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (SHARING_HOSTS.some(h => host === h || host.endsWith('.' + h))) seen.add(url);
  }

  return [...seen].slice(0, 10);
}

/** Le bloc de texte des pièces jointes, tel qu'il entre dans le prompt. */
export function attachmentsToPrompt(files: ReadAttachment[]): string {
  const withText = files.filter(f => f.text.trim());
  if (withText.length === 0) return '';

  return (
    '\n\n--- CONTENU DES PIÈCES JOINTES ---\n' +
    withText.map(f => `### ${f.name}\n${f.text}`).join('\n\n')
  );
}
