import { FormPayload, OFData } from '../types';

/**
 * Validate and parse the form payload into OFData.
 * Accepts an unlimited number of parts.
 */
export function parseFormPayload(payload: FormPayload): OFData {
  const ofNumber = (payload.of || '').trim();
  if (!ofNumber) {
    throw new Error('Numéro OF manquant');
  }

  const parts = (payload.parts || []).filter(p => p.id && p.id.trim());
  if (parts.length === 0) {
    throw new Error('Au moins une pièce avec un ID est requise');
  }

  return { ofNumber, parts };
}

/** Format a date as DD/MM/YYYY */
export function formatDateFR(date: Date = new Date()): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Build Dropbox folder paths for an OF */
export function buildDropboxPaths(ofNumber: string) {
  const base = '/Analyses/RIJ/Achats Externes';
  const main = `${base}/OF${ofNumber}`;
  return {
    main,
    nm: `${main}/NM${ofNumber}`,
    dp: `${main}/DP${ofNumber}`,
  };
}

/** Check if a filename has a PDF extension (case-insensitive) */
export function isPdf(filename: string): boolean {
  return /\.pdf$/i.test(filename);
}

/** Check if a filename has a STEP extension (case-insensitive) */
export function isStep(filename: string): boolean {
  return /\.(stp|step)$/i.test(filename);
}

/** Get the file extension in lowercase */
export function getExtension(filename: string): string {
  const match = filename.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}
