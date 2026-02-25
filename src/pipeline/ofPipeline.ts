import JSZip from 'jszip';
import { OFData, PipelineResult } from '../types';
import { buildDropboxPaths, getExtension, isPdf, isStep } from '../utils/helpers';
import { ofLogger } from '../utils/logger';
import * as dropboxService from '../services/dropbox';
import * as documentGenerator from '../services/documentGenerator';
import * as zipService from '../services/zip';
import { fetchDocsFromWebhook } from '../services/webhookService';

/**
 * Execute the full OF pipeline for an unlimited number of parts.
 *
 * Steps:
 *  1. Create Dropbox folder structure (OF, NM, DP)
 *  2. For each part: search & copy technical files (PDF → NM, STEP → DP)
 *  3. Create ZIP archive from NM folder
 *  4. Generate PDF + DOCX locally
 *  5. Upload PDF, DOCX, ZIP to Dropbox OF folder
 *  6. Delete temporary NM folder
 *  7. Create shared link on OF folder → returned as output
 */
export async function runPipeline(ofData: OFData): Promise<PipelineResult> {
  const { ofNumber, parts } = ofData;
  const log = ofLogger(ofNumber);
  const paths = buildDropboxPaths(ofNumber);

  // ─── Step 1: Create Dropbox folder structure ──────────────────
  log.info('Step 1: Creating Dropbox folder structure');
  await dropboxService.createFolder(paths.main);
  await dropboxService.createFolder(paths.nm);
  await dropboxService.createFolder(paths.dp);
  log.info({ paths }, 'Folder structure created');

  // ─── Step 2: Call Make webhook to get Dropbox doc paths ──────
  log.info({ partCount: parts.length }, 'Step 2: Fetching docs from Make webhook');
  const partIds = parts.map(p => p.id.trim());
  const webhookDocs = await fetchDocsFromWebhook(ofNumber, partIds);
  log.info({ docCount: webhookDocs.length }, 'Webhook returned docs');

  const missingParts: string[] = [];
  let copiedFiles = 0;

  for (const doc of webhookDocs) {
    const sourcePath = doc.path_display || doc.path_lower || doc.path || '';
    const fileName = doc.name || sourcePath.split('/').pop() || '';

    if (!sourcePath) {
      log.warn({ doc }, 'Doc entry has no path — skipping');
      continue;
    }

    if (isPdf(fileName)) {
      const baseName = fileName.replace(/\.pdf$/i, '');
      const destPath = `${paths.nm}/${baseName}.pdf`;
      log.info({ from: sourcePath, to: destPath }, 'Copying PDF');
      await dropboxService.copyFile(sourcePath, destPath);
      copiedFiles++;
    } else if (isStep(fileName)) {
      const ext = getExtension(fileName);
      const baseName = fileName.replace(/\.(stp|step)$/i, '');
      const destPath = `${paths.dp}/${baseName}.${ext}`;
      log.info({ from: sourcePath, to: destPath }, 'Copying STEP');
      await dropboxService.copyFile(sourcePath, destPath);
      copiedFiles++;
    }
  }

  // Track parts that had no matching docs in the webhook response
  const docNames = webhookDocs.map(d => (d.name || '').replace(/\.[^.]+$/, ''));
  for (const id of partIds) {
    if (!docNames.some(name => name === id)) {
      missingParts.push(id);
    }
  }

  // ─── Abort if no technical files were found ─────────────────────
  if (copiedFiles === 0) {
    log.warn({ missingParts }, 'No technical files returned by webhook — aborting pipeline');
    await Promise.all([
      dropboxService.deletePath(paths.nm).catch(() => {}),
      dropboxService.deletePath(paths.dp).catch(() => {}),
      dropboxService.deletePath(paths.main).catch(() => {}),
    ]);
    throw new Error(
      `Aucun fichier technique (PDF/STEP) retourné par le webhook pour les pièces: ${partIds.join(', ')}`,
    );
  }

  // ─── Step 3: Create ZIP from NM folder ────────────────────────
  log.info('Step 3: Creating ZIP archive');
  const zipBuffer = await zipService.createZipFromDropboxFolder(paths.nm, ofNumber);

  // ─── Step 4: Generate PDF + DOCX locally ──────────────────────
  log.info('Step 4: Generating PDF and DOCX');
  const [pdfBuffer, docxBuffer] = await Promise.all([
    documentGenerator.generatePdf(ofNumber, parts),
    documentGenerator.generateDocx(ofNumber, parts),
  ]);

  // ─── Step 5: Upload files to Dropbox OF folder ────────────────
  log.info('Step 5: Uploading files to Dropbox');
  await Promise.all([
    dropboxService.uploadFile(`${paths.main}/${ofNumber}.pdf`, pdfBuffer),
    dropboxService.uploadFile(`${paths.main}/${ofNumber}.docx`, docxBuffer),
    dropboxService.uploadFile(`${paths.main}/NM${ofNumber}.zip`, zipBuffer),
  ]);
  log.info('Files uploaded to Dropbox');

  // ─── Step 6: Build full ZIP of the OF folder contents ──────────
  log.info('Step 6: Building full ZIP of OF folder');
  const fullZip = new JSZip();
  fullZip.file(`${ofNumber}.pdf`, pdfBuffer);
  fullZip.file(`${ofNumber}.docx`, docxBuffer);
  fullZip.file(`NM${ofNumber}.zip`, zipBuffer);

  // Include STEP files from DP folder
  const dpFiles = await dropboxService.listFiles(paths.dp);
  for (const f of dpFiles) {
    const content = await dropboxService.downloadFile(f.pathDisplay);
    fullZip.file(`DP${ofNumber}/${f.name}`, content);
  }

  const fullZipBuffer = await fullZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const zipBase64 = fullZipBuffer.toString('base64');
  log.info({ zipSizeBytes: fullZipBuffer.length }, 'Full ZIP built');

  // ─── Step 7: Delete temporary NM folder ───────────────────────
  log.info('Step 7: Deleting temporary NM folder');
  await dropboxService.deletePath(paths.nm);

  // ─── Step 8: Create shared link for OF folder ─────────────────
  log.info('Step 8: Creating shared link for OF folder');
  const dropboxLink = await dropboxService.createSharedLink(paths.main);

  log.info({ dropboxLink, missingParts }, 'Pipeline completed successfully');
  return { ofNumber, dropboxLink, missingParts, zipBase64 };
}
