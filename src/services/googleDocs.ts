import { google } from 'googleapis';
import { config } from '../config';
import { Part } from '../types';
import { formatDateFR } from '../utils/helpers';
import { ofLogger } from '../utils/logger';
import { getGoogleAuth } from './googleDrive';

/**
 * Create a Google Doc for the OF.
 *
 * - For 1-7 parts: copy the matching template and replace tags
 * - For >7 parts: create a new doc programmatically with a table
 *
 * Returns the created Google Doc ID.
 */
export async function createOFDocument(
  ofNumber: string,
  parts: Part[],
): Promise<string> {
  const log = ofLogger(ofNumber);
  const partCount = parts.length;

  if (partCount <= 7 && config.templateIds[partCount]) {
    return createFromTemplate(ofNumber, parts);
  }

  log.info({ partCount }, 'More than 7 parts — generating doc programmatically');
  return createProgrammatic(ofNumber, parts);
}

/**
 * Template-based generation (1-7 parts).
 * Copies the template, then replaces all {{Tag}} placeholders.
 */
async function createFromTemplate(
  ofNumber: string,
  parts: Part[],
): Promise<string> {
  const log = ofLogger(ofNumber);
  const templateId = config.templateIds[parts.length];

  const auth = await getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });

  // Copy the template
  log.info({ templateId, partCount: parts.length }, 'Copying Google Doc template');
  const copy = await drive.files.copy({
    fileId: templateId,
    requestBody: {
      name: ofNumber,
      parents: [config.googleDriveFolderId],
    },
  });
  const docId = copy.data.id!;
  log.info({ docId }, 'Template copied');

  // Build replacements
  const replacements: Record<string, string> = {
    OF: ofNumber,
    Date: formatDateFR(),
  };

  for (let i = 1; i <= 7; i++) {
    const part = parts[i - 1];
    replacements[`Ref${i}`] = part?.id || '';
    replacements[`Qty${i}`] = part?.quantity || '';
    replacements[`Mat${i}`] = part?.material || '';
    replacements[`Trait${i}`] = part?.processing || '';
    replacements[`Com${i}`] = part?.comment || '';
  }

  // Replace {{Tag}} patterns
  const requests = Object.entries(replacements).map(([tag, value]) => ({
    replaceAllText: {
      containsText: { text: `{{${tag}}}`, matchCase: true },
      replaceText: value,
    },
  }));

  log.info({ replacementCount: requests.length }, 'Replacing tags');
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  });

  log.info({ docId }, 'Google Doc ready');
  return docId;
}

/**
 * Programmatic generation for >7 parts.
 * Creates a new Google Doc from scratch with a summary table.
 */
async function createProgrammatic(
  ofNumber: string,
  parts: Part[],
): Promise<string> {
  const log = ofLogger(ofNumber);
  const auth = await getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });

  // Create an empty doc in the target folder
  const created = await drive.files.create({
    requestBody: {
      name: ofNumber,
      mimeType: 'application/vnd.google-apps.document',
      parents: [config.googleDriveFolderId],
    },
  });
  const docId = created.data.id!;
  log.info({ docId }, 'Empty doc created');

  const date = formatDateFR();
  const rows = parts.length + 1; // header + data rows
  const cols = 6; // #, Réf, Matériel, Quantité, Traitement, Commentaire

  // Build the document content via batch update.
  // Requests are applied in reverse order of their position so indices stay stable.
  const requests: any[] = [];

  // 1) Insert title + date header text first
  const headerText = `Ordre de Fabrication — ${ofNumber}\nDate : ${date}\n\n`;
  requests.push({
    insertText: { location: { index: 1 }, text: headerText },
  });

  // 2) Style the title line
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: 1, endIndex: 1 + `Ordre de Fabrication — ${ofNumber}`.length },
      paragraphStyle: {
        namedStyleType: 'HEADING_1',
        alignment: 'CENTER',
      },
      fields: 'namedStyleType,alignment',
    },
  });

  // 3) Insert the table after the header text
  const tableInsertIndex = 1 + headerText.length;
  requests.push({
    insertTable: {
      rows,
      columns: cols,
      location: { index: tableInsertIndex },
    },
  });

  // Apply the header + table structure first, then we'll populate cells
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  });

  // Read the doc to get table cell positions
  const doc = await docs.documents.get({ documentId: docId });
  const body = doc.data.body?.content || [];

  // Find the table element
  const tableElement = body.find((el: any) => el.table);
  if (!tableElement?.table) {
    throw new Error('Failed to find inserted table in the document');
  }

  const table = tableElement.table;
  const tableRows = table.tableRows || [];
  const cellRequests: any[] = [];

  // Helper: get the start index of a cell's content
  function cellIndex(row: number, col: number): number {
    const cell = tableRows[row]?.tableCells?.[col];
    return cell?.content?.[0]?.startIndex || 0;
  }

  // Header row
  const headers = ['#', 'Réf', 'Matériel', 'Quantité', 'Traitement', 'Commentaire'];
  for (let c = 0; c < cols; c++) {
    const idx = cellIndex(0, c);
    if (idx > 0) {
      cellRequests.push({
        insertText: { location: { index: idx }, text: headers[c] },
      });
      // Bold header cells
      cellRequests.push({
        updateTextStyle: {
          range: { startIndex: idx, endIndex: idx + headers[c].length },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    }
  }

  // Data rows — fill in reverse order so indices remain valid
  for (let r = parts.length; r >= 1; r--) {
    const part = parts[r - 1];
    const values = [
      String(r),
      part.id,
      part.material,
      part.quantity,
      part.processing,
      part.comment,
    ];
    for (let c = cols - 1; c >= 0; c--) {
      const idx = cellIndex(r, c);
      if (idx > 0 && values[c]) {
        cellRequests.push({
          insertText: { location: { index: idx }, text: values[c] },
        });
      }
    }
  }

  // Apply cell content — headers first (higher indices), then data
  // Sort by index descending so inserts don't shift positions
  cellRequests.sort((a: any, b: any) => {
    const idxA = a.insertText?.location?.index ?? a.updateTextStyle?.range?.startIndex ?? 0;
    const idxB = b.insertText?.location?.index ?? b.updateTextStyle?.range?.startIndex ?? 0;
    return idxB - idxA;
  });

  if (cellRequests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: cellRequests },
    });
  }

  log.info({ docId, partCount: parts.length }, 'Programmatic Google Doc created');
  return docId;
}
