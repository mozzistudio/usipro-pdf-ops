import JSZip from 'jszip';
import { ofLogger } from '../utils/logger';
import * as dropboxService from './dropbox';

/**
 * Create a ZIP archive from all PDF files in the NM folder on Dropbox.
 * Downloads each PDF, adds it to a ZIP, and returns the ZIP buffer.
 *
 * This is the self-hosted approach (Option B) — no external service needed.
 */
export async function createZipFromDropboxFolder(
  nmFolderPath: string,
  ofNumber: string,
): Promise<Buffer> {
  const log = ofLogger(ofNumber);
  log.info({ folder: nmFolderPath }, 'Creating ZIP archive from NM folder');

  // List all files in the NM folder
  const files = await dropboxService.listFiles(nmFolderPath);
  const pdfFiles = files.filter(f => /\.pdf$/i.test(f.name));

  if (pdfFiles.length === 0) {
    log.warn('No PDF files found in NM folder for ZIP creation');
  }

  const zip = new JSZip();

  // Download each PDF and add to ZIP
  for (const file of pdfFiles) {
    log.info({ file: file.name }, 'Adding file to ZIP');
    const content = await dropboxService.downloadFile(file.pathDisplay || file.pathLower);
    zip.file(file.name, content);
  }

  // Generate ZIP buffer
  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  log.info(
    { fileCount: pdfFiles.length, sizeBytes: zipBuffer.length },
    'ZIP archive created',
  );
  return zipBuffer;
}
