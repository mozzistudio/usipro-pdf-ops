import { Dropbox, DropboxAuth } from 'dropbox';
import fetch from 'node-fetch';
import { config } from '../config';
import { ofLogger } from '../utils/logger';

let dbxInstance: Dropbox | null = null;

/** Reset the cached client (e.g. after an auth error) */
export function resetClient(): void {
  dbxInstance = null;
}

/** Get or create a Dropbox client, handling token refresh if OAuth2 is configured */
async function getClient(): Promise<Dropbox> {
  if (dbxInstance) return dbxInstance;

  const log = ofLogger('dropbox');

  // If a long-lived access token is provided, use it directly
  if (config.dropbox.accessToken) {
    dbxInstance = new Dropbox({
      accessToken: config.dropbox.accessToken,
      fetch: fetch as any,
    });
    return dbxInstance;
  }

  // Otherwise use OAuth2 refresh token flow
  if (!config.dropbox.refreshToken || !config.dropbox.clientSecret) {
    throw new Error(
      'Dropbox auth not configured: set DROPBOX_ACCESS_TOKEN or both DROPBOX_CLIENT_SECRET and DROPBOX_REFRESH_TOKEN',
    );
  }

  log.info('Creating Dropbox client with OAuth2 refresh token flow');
  const auth = new DropboxAuth({
    clientId: config.dropbox.clientId,
    clientSecret: config.dropbox.clientSecret,
    refreshToken: config.dropbox.refreshToken,
    fetch: fetch as any,
  });

  dbxInstance = new Dropbox({ auth, fetch: fetch as any });
  return dbxInstance;
}

/**
 * Create a folder on Dropbox. Reuses the existing folder if it already exists.
 * Returns the actual path created (or the existing path on conflict).
 */
export async function createFolder(path: string): Promise<string> {
  const dbx = await getClient();
  const log = ofLogger('dropbox');
  try {
    const result = await dbx.filesCreateFolderV2({
      path,
      autorename: false,
    });
    const actualPath = result.result.metadata.path_display || path;
    log.info({ path: actualPath }, 'Folder created');
    return actualPath;
  } catch (err: any) {
    // If folder already exists, reuse it
    if (err?.error?.error_summary?.includes('path/conflict/folder')) {
      log.info({ path }, 'Folder already exists — reusing');
      return path;
    }
    throw err;
  }
}

/**
 * List all files in a Dropbox folder (non-recursive, with pagination).
 * Returns array of file entries with name and path_lower.
 */
export async function listFiles(
  folderPath: string,
): Promise<Array<{ name: string; pathLower: string; pathDisplay: string }>> {
  const dbx = await getClient();
  const allEntries: Array<{ name: string; pathLower: string; pathDisplay: string }> = [];

  let result = await dbx.filesListFolder({
    path: folderPath,
    recursive: false,
  });

  for (const e of result.result.entries) {
    if (e['.tag'] === 'file') {
      allEntries.push({
        name: e.name,
        pathLower: e.path_lower || '',
        pathDisplay: e.path_display || '',
      });
    }
  }

  // Paginate if there are more results
  while (result.result.has_more) {
    result = await dbx.filesListFolderContinue({
      cursor: result.result.cursor,
    });
    for (const e of result.result.entries) {
      if (e['.tag'] === 'file') {
        allEntries.push({
          name: e.name,
          pathLower: e.path_lower || '',
          pathDisplay: e.path_display || '',
        });
      }
    }
  }

  return allEntries;
}

/**
 * List all entries (files AND folders) in a Dropbox folder (non-recursive, with pagination).
 * Returns array of entries with tag, name and paths.
 */
export async function listFolderEntries(
  folderPath: string,
): Promise<Array<{ tag: string; name: string; pathLower: string; pathDisplay: string }>> {
  const dbx = await getClient();
  const log = ofLogger('dropbox');
  const allEntries: Array<{ tag: string; name: string; pathLower: string; pathDisplay: string }> = [];

  let result = await dbx.filesListFolder({
    path: folderPath,
    recursive: false,
  });

  let pageCount = 1;
  for (const e of result.result.entries) {
    allEntries.push({
      tag: e['.tag'],
      name: e.name,
      pathLower: e.path_lower || '',
      pathDisplay: e.path_display || '',
    });
  }
  log.info(
    { folderPath, page: pageCount, entriesInPage: result.result.entries.length, hasMore: result.result.has_more },
    'listFolderEntries page loaded',
  );

  while (result.result.has_more) {
    pageCount++;
    result = await dbx.filesListFolderContinue({
      cursor: result.result.cursor,
    });
    for (const e of result.result.entries) {
      allEntries.push({
        tag: e['.tag'],
        name: e.name,
        pathLower: e.path_lower || '',
        pathDisplay: e.path_display || '',
      });
    }
    log.info(
      { folderPath, page: pageCount, entriesInPage: result.result.entries.length, hasMore: result.result.has_more },
      'listFolderEntries page loaded',
    );
  }

  log.info(
    { folderPath, totalEntries: allEntries.length, totalPages: pageCount },
    'listFolderEntries completed',
  );
  return allEntries;
}

/**
 * Copy a file on Dropbox.
 * If the destination already exists, delete it first to ensure a clean overwrite.
 */
export async function copyFile(fromPath: string, toPath: string): Promise<void> {
  const dbx = await getClient();
  const log = ofLogger('dropbox');
  try {
    await dbx.filesCopyV2({
      from_path: fromPath,
      to_path: toPath,
      autorename: false,
    });
  } catch (err: any) {
    if (err?.error?.error_summary?.includes('to/conflict/file')) {
      // Destination already exists — delete and retry for a clean copy
      log.info({ toPath }, 'Destination file exists — overwriting');
      await dbx.filesDeleteV2({ path: toPath });
      await dbx.filesCopyV2({
        from_path: fromPath,
        to_path: toPath,
        autorename: false,
      });
    } else {
      throw err;
    }
  }
}

/**
 * Create a shared link for a Dropbox path.
 * Returns the URL string.
 */
export async function createSharedLink(path: string): Promise<string> {
  const dbx = await getClient();
  try {
    const result = await dbx.sharingCreateSharedLinkWithSettings({
      path,
      settings: {
        requested_visibility: { '.tag': 'public' },
        audience: { '.tag': 'public' },
        access: { '.tag': 'viewer' },
      },
    });
    return result.result.url;
  } catch (err: any) {
    // If a shared link already exists, retrieve it
    if (err?.error?.error_summary?.startsWith('shared_link_already_exists')) {
      const existing = await dbx.sharingListSharedLinks({
        path,
        direct_only: true,
      });
      if (existing.result.links.length > 0) {
        return existing.result.links[0].url;
      }
    }
    throw err;
  }
}

/**
 * Upload a file to Dropbox. Uses upload sessions for files > 150MB.
 */
export async function uploadFile(
  path: string,
  contents: Buffer,
): Promise<void> {
  const dbx = await getClient();
  const LARGE_FILE_THRESHOLD = 150 * 1024 * 1024; // 150 MB

  if (contents.length <= LARGE_FILE_THRESHOLD) {
    await dbx.filesUpload({
      path,
      contents,
      mode: { '.tag': 'overwrite' },
      autorename: true,
    });
  } else {
    // Large file upload via session
    const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB chunks
    let offset = 0;

    // Start session
    const startResult = await dbx.filesUploadSessionStart({
      contents: contents.subarray(0, CHUNK_SIZE),
      close: false,
    });
    const sessionId = startResult.result.session_id;
    offset = CHUNK_SIZE;

    // Append chunks
    while (offset < contents.length - CHUNK_SIZE) {
      await dbx.filesUploadSessionAppendV2({
        cursor: { session_id: sessionId, offset },
        contents: contents.subarray(offset, offset + CHUNK_SIZE),
        close: false,
      });
      offset += CHUNK_SIZE;
    }

    // Finish session with the last chunk
    await dbx.filesUploadSessionFinish({
      cursor: { session_id: sessionId, offset },
      commit: {
        path,
        mode: { '.tag': 'overwrite' },
        autorename: true,
      },
      contents: contents.subarray(offset),
    });
  }
}

/**
 * Search for files/folders by name under a given path using Dropbox search API.
 * Returns matching entries with tag, name and paths.
 */
export async function searchByName(
  query: string,
  searchPath: string,
): Promise<Array<{ tag: string; name: string; pathLower: string; pathDisplay: string }>> {
  const dbx = await getClient();
  const log = ofLogger('dropbox');

  const result = await dbx.filesSearchV2({
    query,
    options: {
      path: searchPath,
      max_results: 20,
      file_status: { '.tag': 'active' },
      filename_only: true,
    },
  });

  const entries: Array<{ tag: string; name: string; pathLower: string; pathDisplay: string }> = [];
  for (const match of result.result.matches) {
    const meta = (match.metadata as any)?.metadata;
    if (meta) {
      entries.push({
        tag: meta['.tag'] || 'file',
        name: meta.name || '',
        pathLower: meta.path_lower || '',
        pathDisplay: meta.path_display || '',
      });
    }
  }

  log.info({ query, searchPath, matchCount: entries.length }, 'Dropbox search completed');
  return entries;
}

/**
 * Download a file from Dropbox. Returns the file contents as a Buffer.
 */
export async function downloadFile(path: string): Promise<Buffer> {
  const dbx = await getClient();
  const result = await dbx.filesDownload({ path });
  // The SDK adds a `fileBinary` property on the result for downloaded content
  return (result.result as any).fileBinary as Buffer;
}

/**
 * Delete a folder (or file) on Dropbox.
 */
export async function deletePath(path: string): Promise<void> {
  const dbx = await getClient();
  await dbx.filesDeleteV2({ path });
}
