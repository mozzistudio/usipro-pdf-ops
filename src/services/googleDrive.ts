import { google, Auth } from 'googleapis';
import * as fs from 'fs';
import { config } from '../config';
import { ofLogger } from '../utils/logger';

let authClient: Auth.OAuth2Client | Auth.GoogleAuth | null = null;

/**
 * Get a Google API auth client.
 * Supports either a service account key file or OAuth2 with refresh token.
 */
export async function getGoogleAuth(): Promise<Auth.OAuth2Client | Auth.GoogleAuth> {
  if (authClient) return authClient;

  if (config.google.serviceAccountKeyPath) {
    // Service account authentication
    const keyFile = config.google.serviceAccountKeyPath;
    if (!fs.existsSync(keyFile)) {
      throw new Error(`Service account key file not found: ${keyFile}`);
    }
    authClient = new google.auth.GoogleAuth({
      keyFile,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/gmail.send',
      ],
    });
    return authClient;
  }

  // OAuth2 authentication
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
  );
  oauth2.setCredentials({
    refresh_token: config.google.refreshToken,
  });
  authClient = oauth2;
  return authClient;
}

/**
 * Export a Google Doc as PDF. Returns the file content as a Buffer.
 */
export async function exportAsPdf(docId: string): Promise<Buffer> {
  const log = ofLogger('gdrive');
  const auth = await getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });

  log.info({ docId }, 'Exporting Google Doc as PDF');
  const res = await drive.files.export(
    { fileId: docId, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

/**
 * Export a Google Doc as DOCX. Returns the file content as a Buffer.
 */
export async function exportAsDocx(docId: string): Promise<Buffer> {
  const log = ofLogger('gdrive');
  const auth = await getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });

  log.info({ docId }, 'Exporting Google Doc as DOCX');
  const res = await drive.files.export(
    {
      fileId: docId,
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data as ArrayBuffer);
}
