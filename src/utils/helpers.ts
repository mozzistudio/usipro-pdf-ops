import { OFData, Part, WebflowWebhookPayload } from '../types';

const MAX_PARTS = 7;
const MAX_FILE_PARTS = 5;

/**
 * Parse the Webflow form data into structured OFData.
 * Extracts non-empty parts and separates file-searchable parts (1-5) from all parts (1-7).
 */
export function parseWebhookData(payload: WebflowWebhookPayload): OFData {
  const { data } = payload;
  const ofNumber = data.OF;

  if (!ofNumber) {
    throw new Error('Missing OF number in webhook payload');
  }

  const allParts: Part[] = [];

  for (let i = 1; i <= MAX_PARTS; i++) {
    const id = (data[`ID${i}`] || '').trim();
    if (!id) continue;

    allParts.push({
      index: i,
      id,
      material: (data[`material${i}`] || '').trim(),
      quantity: (data[`quantity${i}`] || '').trim(),
      processing: (data[`processing${i}`] || '').trim(),
      comment: (data[`comment${i}`] || '').trim(),
    });
  }

  const fileParts = allParts.filter(p => p.index <= MAX_FILE_PARTS);

  return { ofNumber, allParts, fileParts };
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
