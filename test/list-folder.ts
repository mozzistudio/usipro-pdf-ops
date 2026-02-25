/**
 * Quick script to list the contents of a specific Dropbox folder.
 *
 * Usage:
 *   npx ts-node test/list-folder.ts /Analyses/RIJ/Plans/13383
 */

import { Dropbox, DropboxAuth } from 'dropbox';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const folderPath = process.argv[2];
  if (!folderPath) {
    console.error('Usage: npx ts-node test/list-folder.ts <dropbox-folder-path>');
    process.exit(1);
  }

  const clientId = process.env.DROPBOX_CLIENT_ID || 'rp9ta3297qkrkoh';
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET || '';
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN || '';
  const accessToken = process.env.DROPBOX_ACCESS_TOKEN || '';

  if (!accessToken && (!clientSecret || !refreshToken)) {
    console.error('ERROR: Set DROPBOX_ACCESS_TOKEN or both DROPBOX_CLIENT_SECRET + DROPBOX_REFRESH_TOKEN in .env');
    process.exit(1);
  }

  let dbx: Dropbox;
  if (accessToken) {
    dbx = new Dropbox({ accessToken, fetch: fetch as any });
  } else {
    const auth = new DropboxAuth({
      clientId,
      clientSecret,
      refreshToken,
      fetch: fetch as any,
    });
    dbx = new Dropbox({ auth, fetch: fetch as any });
  }

  console.log(`\nListing: ${folderPath}\n`);

  try {
    let result = await dbx.filesListFolder({ path: folderPath, recursive: false });
    const allEntries: Array<{ tag: string; name: string; path: string }> = [];

    for (const e of result.result.entries) {
      allEntries.push({ tag: e['.tag'], name: e.name, path: e.path_display || '' });
    }

    while (result.result.has_more) {
      result = await dbx.filesListFolderContinue({ cursor: result.result.cursor });
      for (const e of result.result.entries) {
        allEntries.push({ tag: e['.tag'], name: e.name, path: e.path_display || '' });
      }
    }

    if (allEntries.length === 0) {
      console.log('(empty folder)');
    } else {
      console.log(`Found ${allEntries.length} entries:\n`);
      for (const entry of allEntries) {
        const icon = entry.tag === 'folder' ? '📁' : '📄';
        console.log(`  ${icon} ${entry.name}    (${entry.path})`);
      }
    }
  } catch (err: any) {
    const summary = err?.error?.error_summary || '';
    if (summary.includes('path/not_found')) {
      console.log(`❌ Folder not found: ${folderPath}`);
    } else {
      console.error('Error:', summary || err.message);
    }
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
