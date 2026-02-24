import { google } from 'googleapis';
import { config } from '../config';
import { Part } from '../types';
import { formatDateFR } from '../utils/helpers';
import { ofLogger } from '../utils/logger';
import { getGoogleAuth } from './googleDrive';

/**
 * Create a Google Doc from a template, perform tag replacements, and return the new doc ID.
 *
 * Template selection is based on the number of non-empty parts (1-7).
 * Tags replaced: OF, Date, Ref1-7, Qty1-7, Mat1-7, Trait1-7, Com1-7
 */
export async function createOFDocument(
  ofNumber: string,
  parts: Part[],
): Promise<string> {
  const log = ofLogger(ofNumber);
  const partCount = parts.length;
  const templateId = config.templateIds[partCount];

  if (!templateId) {
    throw new Error(
      `No Google Doc template configured for ${partCount} parts`,
    );
  }

  const auth = await getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });

  // Step 1: Copy the template into the destination folder
  log.info({ templateId, partCount }, 'Copying Google Doc template');
  const copy = await drive.files.copy({
    fileId: templateId,
    requestBody: {
      name: ofNumber,
      parents: [config.googleDriveFolderId],
    },
  });

  const newDocId = copy.data.id!;
  log.info({ docId: newDocId }, 'Template copied');

  // Step 2: Build the batch of replacement requests
  const replacements: Record<string, string> = {
    OF: ofNumber,
    Date: formatDateFR(),
  };

  // Map parts to their tag values — use all 7 slots
  for (let i = 1; i <= 7; i++) {
    const part = parts.find(p => p.index === i);
    replacements[`Ref${i}`] = part?.id || '';
    replacements[`Qty${i}`] = part?.quantity || '';
    replacements[`Mat${i}`] = part?.material || '';
    replacements[`Trait${i}`] = part?.processing || '';
    replacements[`Com${i}`] = part?.comment || '';
  }

  const requests = Object.entries(replacements).map(([tag, value]) => ({
    replaceAllText: {
      containsText: {
        text: `{{${tag}}}`,
        matchCase: true,
      },
      replaceText: value,
    },
  }));

  // Also try without curly braces in case the templates use plain tags
  Object.entries(replacements).forEach(([tag, value]) => {
    requests.push({
      replaceAllText: {
        containsText: {
          text: tag,
          matchCase: true,
        },
        replaceText: value,
      },
    });
  });

  log.info(
    { replacementCount: requests.length },
    'Performing tag replacements',
  );

  await docs.documents.batchUpdate({
    documentId: newDocId,
    requestBody: { requests },
  });

  log.info({ docId: newDocId }, 'Google Doc created and populated');
  return newDocId;
}
