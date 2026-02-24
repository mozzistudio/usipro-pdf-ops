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
  const { accessToken, clientId, clientSecret, refreshToken } = config.dropbox;

  // Option 1: long-lived access token (simple but expires after ~4 h)
  if (accessToken) {
    log.info('Using Dropbox access token directly');
    dbxInstance = new Dropbox({
      accessToken,
      fetch: fetch as any,
    });
    return dbxInstance;
  }

  // Option 2: OAuth2 refresh-token flow — validate all required credentials
  if (!refreshToken) {
    throw new Error(
      'Dropbox auth not configured: set DROPBOX_ACCESS_TOKEN for quick testing, ' +
      'or provide DROPBOX_CLIENT_ID + DROPBOX_CLIENT_SECRET + DROPBOX_REFRESH_TOKEN for production.',
    );
  }
  if (!clientSecret) {
    throw new Error(
      'Dropbox: DROPBOX_CLIENT_SECRET is required when using the refresh-token flow.',
    );
  }

  log.info('Creating Dropbox client with OAuth2 refresh token flow');
  const auth = new DropboxAuth({
    clientId,
    clientSecret,
    refreshToken,
    fetch: fetch as any,
  });

  // Explicitly obtain an access token so auth errors surface immediately
  // instead of producing a cryptic "Invalid authorization value" later.
  try {
    await auth.refreshAccessToken();
    log.info('Dropbox access token obtained via refresh');
  } catch (err: any) {
    const detail = err?.error?.error_description || err?.error?.error || err.message;
    throw new Error(
      `Dropbox token refresh failed: ${detail}. ` +
      'Verify DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET and DROPBOX_REFRESH_TOKEN in your environment.',
    );
  }

  dbxInstance = new Dropbox({ auth, fetch: fetch as any });
  return dbxInstance;
}

/**
 * Create a folder on Dropbox. Uses autorename to handle conflicts.
 * Returns the actual path created.
 */
export async function createFolder(path: string): Promise<string> {
  const dbx = await getClient();
  const log = ofLogger('dropbox');
  try {
    const result = await dbx.filesCreateFolderV2({
      path,
      autorename: true,
    });
    const actualPath = result.result.metadata.path_display || path;
    log.info({ path: actualPath }, 'Folder created');
    return actualPath;
  } catch (err: any) {
    // If folder already exists, that's fine
    if (err?.error?.error_summary?.startsWith('path/conflict/folder')) {
      log.info({ path }, 'Folder already exists');
      return path;
    }
    throw err;
  }
}

/**
 * List files in a Dropbox folder (non-recursive, limit 10).
 * Returns array of file entries with name and path_lower.
 */
export async function listFiles(
  folderPath: string,
): Promise<Array<{ name: string; pathLower: string; pathDisplay: string }>> {
  const dbx = await getClient();
  const result = await dbx.filesListFolder({
    path: folderPath,
    recursive: false,
    limit: 10,
  });

  return result.result.entries
    .filter(e => e['.tag'] === 'file')
    .map(e => ({
      name: e.name,
      pathLower: e.path_lower || '',
      pathDisplay: e.path_display || '',
    }));
}

/**
 * Copy a file on Dropbox.
 */
export async function copyFile(fromPath: string, toPath: string): Promise<void> {
  const dbx = await getClient();
  await dbx.filesCopyV2({
    from_path: fromPath,
    to_path: toPath,
    autorename: true,
  });
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
