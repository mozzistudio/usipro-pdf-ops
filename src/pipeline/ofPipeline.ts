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

  // List the Plans parent directory to discover available part folders.
  // This is more robust than constructing paths directly, as Dropbox returns
  // the exact paths it knows about (handles namespace/casing/shared folder edge cases).
  const plansBasePath = '/Analyses/RIJ/Plans';
  const folderMap = new Map<string, string>(); // folder name (lowercase) → pathDisplay
  const fileMap = new Map<string, Array<{ name: string; pathLower: string; pathDisplay: string }>>(); // part ID → files in Plans root

  let plansListed = false;
  try {
    const entries = await dropboxService.listFolderEntries(plansBasePath);
    for (const entry of entries) {
      if (entry.tag === 'folder') {
        folderMap.set(entry.name.toLowerCase(), entry.pathDisplay);
      } else if (entry.tag === 'file') {
        // Files directly in Plans folder (e.g. 13414.pdf)
        const baseName = entry.name.replace(/\.[^.]+$/, '').toLowerCase();
        if (!fileMap.has(baseName)) fileMap.set(baseName, []);
        fileMap.get(baseName)!.push({
          name: entry.name,
          pathLower: entry.pathLower,
          pathDisplay: entry.pathDisplay,
        });
      }
    }
    plansListed = true;
    log.info({ folderCount: folderMap.size, fileCount: fileMap.size }, 'Plans directory listed');

    // Debug: log folder names that match any requested part ID
    for (const part of parts) {
      const pid = part.id.trim().toLowerCase();
      const exactMatch = folderMap.has(pid);
      const directMatch = fileMap.has(pid);
      const fuzzyMatches: string[] = [];
      for (const folderName of folderMap.keys()) {
        if (folderName.startsWith(pid) || folderName.includes(pid)) {
          fuzzyMatches.push(folderName);
        }
      }
      log.info(
        { partId: part.id.trim(), exactFolderMatch: exactMatch, directFileMatch: directMatch, fuzzyFolderMatches: fuzzyMatches },
        'Pre-match diagnostics for part',
      );
    }

    // Debug: log a sample of folder names to help diagnose mismatches
    const folderNames = Array.from(folderMap.keys());
    log.info(
      { sampleFolders: folderNames.slice(0, 30), totalFolders: folderNames.length },
      'Sample of folder names in Plans directory',
    );
  } catch (err: any) {
    const errDetail = err?.error?.error_summary || err?.message || 'unknown';
    log.warn({ err: errDetail }, 'Cannot list Plans directory — falling back to direct path lookup');
  }

  for (const part of parts) {
    const partId = part.id.trim();
    log.info({ partId }, 'Searching files for part');

    // Strategy 1: Exact match from folder map
    let mappedFolderPath = folderMap.get(partId.toLowerCase());

    // Strategy 1b: Fuzzy match — folder name starts with or contains the part ID
    if (!mappedFolderPath && plansListed) {
      for (const [folderName, folderPath] of folderMap) {
        if (folderName.startsWith(partId.toLowerCase()) || folderName.includes(partId.toLowerCase())) {
          log.info({ partId, matchedFolder: folderName }, 'Fuzzy-matched part folder');
          mappedFolderPath = folderPath;
          break;
        }
      }
    }

    // Strategy 2: Check for files directly in Plans folder matching part ID
    const directFiles = fileMap.get(partId.toLowerCase());

    let files: Array<{ name: string; pathLower: string; pathDisplay: string }> = [];

    if (mappedFolderPath) {
      // Found the folder in the Plans directory — list its contents
      log.info({ partId, sourcePath: mappedFolderPath }, 'Found part folder in Plans directory');
      try {
        files = await dropboxService.listFiles(mappedFolderPath);
      } catch (err: any) {
        const errDetail = err?.error?.error_summary || err?.message || 'unknown';
        log.warn({ partId, err: errDetail }, 'Failed to list part folder contents');
        missingParts.push(partId);
        continue;
      }
    } else if (directFiles && directFiles.length > 0) {
      // Files found directly in Plans folder (not in a subfolder)
      log.info({ partId, fileCount: directFiles.length }, 'Found part files directly in Plans directory');
      files = directFiles;
    } else {
      // Strategy 3: Always try direct path — handles cases where the listing
      // succeeded but missed an entry (large directory, pagination edge case,
      // namespace mismatch, etc.)
      const sourcePath = `${plansBasePath}/${partId}`;
      log.info({ partId, sourcePath, plansListed }, 'Trying direct path lookup');
      let directPathFound = false;
      try {
        files = await dropboxService.listFiles(sourcePath);
        directPathFound = true;
        log.info({ partId, sourcePath, fileCount: files.length }, 'Direct path lookup succeeded');
      } catch (err: any) {
        const summary = typeof err?.error === 'string'
          ? err.error
          : err?.error?.error_summary || '';
        if (typeof summary === 'string' && summary.includes('path/not_found')) {
          log.info({ partId, sourcePath }, 'Direct path not found — trying search');
        } else {
          throw err;
        }
      }

      // Strategy 4: Use Dropbox search API as final fallback
      if (!directPathFound) {
        try {
          const searchResults = await dropboxService.searchByName(partId, plansBasePath);
          // Look for a folder whose name matches the part ID
          const matchedFolder = searchResults.find(
            (e) => e.tag === 'folder' && e.name.toLowerCase() === partId.toLowerCase(),
          );
          // Also accept folders that start with or contain the part ID
          const fuzzyFolder = !matchedFolder
            ? searchResults.find(
                (e) => e.tag === 'folder' && (
                  e.name.toLowerCase().startsWith(partId.toLowerCase()) ||
                  e.name.toLowerCase().includes(partId.toLowerCase())
                ),
              )
            : undefined;
          const foundFolder = matchedFolder || fuzzyFolder;

          if (foundFolder) {
            log.info({ partId, foundPath: foundFolder.pathDisplay }, 'Found part via Dropbox search');
            try {
              files = await dropboxService.listFiles(foundFolder.pathDisplay);
            } catch (listErr: any) {
              const errDetail = listErr?.error?.error_summary || listErr?.message || 'unknown';
              log.warn({ partId, err: errDetail }, 'Failed to list search-matched folder');
            }
          } else {
            // Check if there are matching files directly
            const matchedFiles = searchResults.filter(
              (e) => e.tag === 'file' && e.name.replace(/\.[^.]+$/, '').toLowerCase() === partId.toLowerCase(),
            );
            if (matchedFiles.length > 0) {
              log.info({ partId, fileCount: matchedFiles.length }, 'Found part files via Dropbox search');
              files = matchedFiles.map((e) => ({
                name: e.name,
                pathLower: e.pathLower,
                pathDisplay: e.pathDisplay,
              }));
            }
          }
        } catch (searchErr: any) {
          log.warn({ partId, err: searchErr?.message || 'unknown' }, 'Dropbox search failed');
        }
      }

      // If still nothing found after all strategies, mark as missing
      if (files.length === 0) {
        const nearMatches: string[] = [];
        for (const folderName of folderMap.keys()) {
          if (folderName.includes(partId.toLowerCase()) || partId.toLowerCase().includes(folderName)) {
            nearMatches.push(folderName);
          }
        }
        log.warn(
          { partId, plansListed, folderMapSize: folderMap.size, fileMapSize: fileMap.size, nearMatches },
          'Part not found after all strategies — skipping',
        );
        missingParts.push(partId);
        continue;
      }
    }

    log.info(
      { partId, fileCount: files.length, fileNames: files.map(f => f.name) },
      'Files found for part',
    );

    if (files.length === 0) {
      log.warn({ partId }, 'Folder exists but contains no files — marking as missing');
      missingParts.push(partId);
    }

    for (const file of files) {
      const ext = getExtension(file.name);

      if (isPdf(file.name)) {
        const destPath = `${paths.nm}/${partId}.pdf`;
        log.info({ from: file.pathDisplay, to: destPath }, 'Copying PDF');
        await dropboxService.copyFile(file.pathDisplay, destPath);
      } else if (isStep(file.name)) {
        const destPath = `${paths.dp}/${partId}.${ext}`;
        log.info({ from: file.pathDisplay, to: destPath }, 'Copying STEP');
        await dropboxService.copyFile(file.pathDisplay, destPath);
      }
    }
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

  // ─── Step 6: Delete temporary NM folder ───────────────────────
  log.info('Step 6: Deleting temporary NM folder');
  await dropboxService.deletePath(paths.nm);

  // ─── Step 7: Create shared link for OF folder ─────────────────
  log.info('Step 7: Creating shared link for OF folder');
  const dropboxLink = await dropboxService.createSharedLink(paths.main);

  log.info({ dropboxLink, missingParts }, 'Pipeline completed successfully');
  return { ofNumber, dropboxLink, missingParts };
}
