import JSZip from 'jszip';
import { OFData, PipelineResult } from '../types';
import { buildDropboxPaths, getExtension, isPdf, isStep } from '../utils/helpers';
import { ofLogger } from '../utils/logger';
import * as dropboxService from '../services/dropbox';
import * as documentGenerator from '../services/documentGenerator';
import * as zipService from '../services/zip';

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

  // ─── Step 2: Search & copy technical files for every part ─────
  log.info({ partCount: parts.length }, 'Step 2: Searching and copying technical files');
  const missingParts: string[] = [];
  const plansBasePath = '/Analyses/RIJ/Plans';

  let copiedFiles = 0;

  for (const part of parts) {
    const partId = part.id.trim();
    let sourcePath = `${plansBasePath}/${partId}`;
    log.info({ partId, sourcePath }, 'Looking up part folder');

    let files: Array<{ name: string; pathLower: string; pathDisplay: string }> = [];
    try {
      files = await dropboxService.listFiles(sourcePath);
      log.info({ partId, sourcePath, fileCount: files.length, fileNames: files.map(f => f.name) }, 'Part folder found — direct listing succeeded');
    } catch (err: any) {
      const errSummary = typeof err?.error === 'string'
        ? err.error
        : err?.error?.error_summary || '';
      log.warn(
        { partId, sourcePath, errStatus: err?.status, errSummary, errMessage: err?.message },
        'Direct folder listing failed',
      );

      if (typeof errSummary === 'string' && errSummary.includes('path/not_found')) {
        // Fallback 1: search for a folder whose name matches the partId
        log.info({ partId, plansBasePath }, 'Exact folder not found — trying fallback: folder name matching in parent');
        try {
          const matchedPath = await dropboxService.findMatchingFolder(plansBasePath, partId);
          if (matchedPath) {
            sourcePath = matchedPath;
            log.info({ partId, matchedPath }, 'Found matching folder via fallback search');
            files = await dropboxService.listFiles(sourcePath);
            log.info({ partId, sourcePath, fileCount: files.length, fileNames: files.map(f => f.name) }, 'Matched folder listed');
          } else {
            log.warn({ partId, plansBasePath }, 'No matching folder found in parent listing');
          }
        } catch (fallbackErr: any) {
          log.warn(
            { partId, errMessage: fallbackErr?.message, errStatus: fallbackErr?.status, errSummary: fallbackErr?.error?.error_summary },
            'Fallback folder search failed',
          );
        }

        // Fallback 2: use Dropbox search API if folder matching didn't find files
        if (files.length === 0) {
          log.info({ partId, plansBasePath }, 'Trying fallback: Dropbox search API');
          try {
            const searchResults = await dropboxService.searchByName(partId, plansBasePath);
            log.info(
              { partId, searchResultCount: searchResults.length, searchResults: searchResults.map(r => ({ tag: r.tag, name: r.name, path: r.pathDisplay })) },
              'Dropbox search API results',
            );

            // Look for a folder matching the partId in search results
            const matchedFolder = searchResults.find(
              r => r.tag === 'folder' && r.name.toLowerCase() === partId.toLowerCase(),
            );
            if (matchedFolder) {
              sourcePath = matchedFolder.pathDisplay;
              log.info({ partId, matchedPath: sourcePath }, 'Found folder via Dropbox search API');
              files = await dropboxService.listFiles(sourcePath);
              log.info({ partId, sourcePath, fileCount: files.length, fileNames: files.map(f => f.name) }, 'Search-matched folder listed');
            } else {
              // Also check if search found files directly (PDF/STEP under plans path)
              const techFiles = searchResults.filter(
                r => r.tag === 'file' && (isPdf(r.name) || isStep(r.name)),
              );
              if (techFiles.length > 0) {
                log.info({ partId, fileCount: techFiles.length }, 'Found technical files directly via search API');
                files = techFiles.map(f => ({ name: f.name, pathLower: f.pathLower, pathDisplay: f.pathDisplay }));
              }
            }
          } catch (searchErr: any) {
            log.warn(
              { partId, errMessage: searchErr?.message, errStatus: searchErr?.status },
              'Dropbox search API fallback failed',
            );
          }
        }

        if (files.length === 0) {
          log.warn({ partId, sourcePath }, 'All search methods failed — skipping part');
          missingParts.push(partId);
          continue;
        }
      } else {
        // Non path/not_found error — log details and rethrow
        log.error(
          { partId, sourcePath, errStatus: err?.status, errSummary, errMessage: err?.message, errBody: err?.error },
          'Unexpected Dropbox error during folder listing',
        );
        throw err;
      }
    }

    // If no direct files, try recursive search (files may be inside subfolders)
    if (files.length === 0) {
      log.info({ partId, sourcePath }, 'No direct files — trying recursive search in subfolders');
      try {
        files = await dropboxService.listFilesRecursive(sourcePath);
        log.info({ partId, fileCount: files.length, fileNames: files.map(f => f.name) }, 'Recursive search results');
      } catch (recErr: any) {
        log.warn(
          { partId, sourcePath, errMessage: recErr?.message, errStatus: recErr?.status },
          'Recursive search failed',
        );
      }
    }

    if (files.length === 0) {
      log.warn({ partId, sourcePath }, 'Part folder exists but has no files — skipping');
      missingParts.push(partId);
      continue;
    }

    log.info({ partId, fileCount: files.length, fileNames: files.map(f => f.name) }, 'Processing files for part');

    for (const file of files) {
      const ext = getExtension(file.name);

      if (isPdf(file.name)) {
        const destPath = `${paths.nm}/${partId}.pdf`;
        log.info({ from: file.pathDisplay, to: destPath }, 'Copying PDF');
        await dropboxService.copyFile(file.pathDisplay, destPath);
        copiedFiles++;
      } else if (isStep(file.name)) {
        const destPath = `${paths.dp}/${partId}.${ext}`;
        log.info({ from: file.pathDisplay, to: destPath }, 'Copying STEP');
        await dropboxService.copyFile(file.pathDisplay, destPath);
        copiedFiles++;
      } else {
        log.info({ partId, fileName: file.name, ext }, 'Skipping non-technical file');
      }
    }
  }

  // ─── Abort if no technical files were found ─────────────────────
  if (copiedFiles === 0) {
    log.warn({ missingParts }, 'No technical files found for any part — aborting pipeline');
    // Clean up the empty folders we created
    await Promise.all([
      dropboxService.deletePath(paths.nm).catch(() => {}),
      dropboxService.deletePath(paths.dp).catch(() => {}),
      dropboxService.deletePath(paths.main).catch(() => {}),
    ]);
    throw new Error(
      `Aucun fichier technique (PDF/STEP) trouvé pour les pièces: ${missingParts.join(', ')}`,
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
