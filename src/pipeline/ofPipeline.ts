import { OFData, PipelineResult } from '../types';
import { buildDropboxPaths, getExtension, isPdf, isStep } from '../utils/helpers';
import { ofLogger } from '../utils/logger';
import * as dropboxService from '../services/dropbox';
import * as googleDocsService from '../services/googleDocs';
import * as googleDriveService from '../services/googleDrive';
import * as zipService from '../services/zip';
import * as emailService from '../services/email';

/**
 * Execute the full OF pipeline for an unlimited number of parts.
 *
 * Steps:
 *  1. Create Dropbox folder structure (OF, NM, DP)
 *  2. For each part: search & copy technical files (PDF → NM, STEP → DP)
 *  3. Create shared link for NM folder
 *  4. Create ZIP archive from NM folder
 *  5. Generate Google Doc (template ≤7 parts, programmatic >7)
 *  6. Export Google Doc as PDF + DOCX
 *  7. Upload PDF, DOCX, ZIP to Dropbox OF folder
 *  8. Delete temporary NM folder
 *  9. Create shared link on OF folder
 * 10. Send confirmation email with 3 attachments
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

  // ─── Step 2: Search & copy technical files for every part ─────
  log.info({ partCount: parts.length }, 'Step 2: Searching and copying technical files');
  for (const part of parts) {
    const sourcePath = `/analyses/rij/plans/${part.id}`;
    log.info({ partId: part.id, sourcePath }, 'Searching files for part');

    let files: Array<{ name: string; pathLower: string; pathDisplay: string }>;
    try {
      files = await dropboxService.listFiles(sourcePath);
    } catch (err: any) {
      const summary = err?.error?.error_summary || '';
      if (summary.includes('path/not_found')) {
        log.error({ partId: part.id }, 'Source folder not found — sending error email');
        await emailService.sendErrorEmail(ofNumber);
        return { ofNumber, dropboxLink: '', emailSent: true };
      }
      throw err;
    }

    for (const file of files) {
      const ext = getExtension(file.name);

      if (isPdf(file.name)) {
        const destPath = `${paths.nm}/${part.id}.pdf`;
        log.info({ from: file.pathDisplay, to: destPath }, 'Copying PDF');
        await dropboxService.copyFile(file.pathDisplay, destPath);
      } else if (isStep(file.name)) {
        const destPath = `${paths.dp}/${part.id}.${ext}`;
        log.info({ from: file.pathDisplay, to: destPath }, 'Copying STEP');
        await dropboxService.copyFile(file.pathDisplay, destPath);
      }
    }
  }

  // ─── Step 3: Create shared link for NM folder ─────────────────
  log.info('Step 3: Creating shared link for NM folder');
  await dropboxService.createSharedLink(paths.nm);

  // ─── Step 4: Create ZIP from NM folder ────────────────────────
  log.info('Step 4: Creating ZIP archive');
  const zipBuffer = await zipService.createZipFromDropboxFolder(paths.nm, ofNumber);

  // ─── Step 5: Generate Google Doc ──────────────────────────────
  log.info('Step 5: Generating Google Doc');
  const docId = await googleDocsService.createOFDocument(ofNumber, parts);

  // ─── Step 6: Export Google Doc as PDF + DOCX ──────────────────
  log.info('Step 6: Exporting Google Doc as PDF and DOCX');
  const [pdfBuffer, docxBuffer] = await Promise.all([
    googleDriveService.exportAsPdf(docId),
    googleDriveService.exportAsDocx(docId),
  ]);

  // ─── Step 7: Upload files to Dropbox OF folder ────────────────
  log.info('Step 7: Uploading files to Dropbox');
  await Promise.all([
    dropboxService.uploadFile(`${paths.main}/${ofNumber}.pdf`, pdfBuffer),
    dropboxService.uploadFile(`${paths.main}/${ofNumber}.docx`, docxBuffer),
    dropboxService.uploadFile(`${paths.main}/NM${ofNumber}.zip`, zipBuffer),
  ]);
  log.info('Files uploaded to Dropbox');

  // ─── Step 8: Delete temporary NM folder ───────────────────────
  log.info('Step 8: Deleting temporary NM folder');
  await dropboxService.deletePath(paths.nm);

  // ─── Step 9: Create shared link for OF folder ─────────────────
  log.info('Step 9: Creating shared link for OF folder');
  const dropboxLink = await dropboxService.createSharedLink(paths.main);

  // ─── Step 10: Send confirmation email ─────────────────────────
  log.info('Step 10: Sending confirmation email');
  await emailService.sendConfirmationEmail(
    ofNumber,
    dropboxLink,
    zipBuffer,
    pdfBuffer,
    docxBuffer,
  );

  log.info({ dropboxLink }, 'Pipeline completed successfully');
  return { ofNumber, dropboxLink, emailSent: true };
}
