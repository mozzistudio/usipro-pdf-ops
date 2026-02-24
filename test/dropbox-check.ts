/**
 * Quick Dropbox connectivity test.
 *
 * Usage:
 *   1. Copy .env.example → .env and fill in DROPBOX_CLIENT_SECRET + DROPBOX_REFRESH_TOKEN
 *   2. Run: npx ts-node test/dropbox-check.ts
 *
 * This will:
 *   - Authenticate with Dropbox using the refresh token
 *   - List the root of /Analyses/RIJ to confirm read access
 *   - List /analyses/rij/plans to confirm the plans folder exists
 */

import { Dropbox, DropboxAuth } from 'dropbox';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const clientId = process.env.DROPBOX_CLIENT_ID || 'rp9ta3297qkrkoh';
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET || '';
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN || '';
  const accessToken = process.env.DROPBOX_ACCESS_TOKEN || '';

  console.log('── Dropbox Connectivity Check ──\n');

  // 1. Check credentials
  console.log('Credentials:');
  console.log(`  CLIENT_ID:      ${clientId ? '✓' : '✗ MISSING'}`);
  console.log(`  CLIENT_SECRET:   ${clientSecret ? '✓ (' + clientSecret.substring(0, 6) + '...)' : '✗ MISSING'}`);
  console.log(`  REFRESH_TOKEN:   ${refreshToken ? '✓ (' + refreshToken.substring(0, 6) + '...)' : '✗ MISSING'}`);
  console.log(`  ACCESS_TOKEN:    ${accessToken ? '✓ (direct token)' : '– not set (using refresh flow)'}`);
  console.log();

  if (!accessToken && (!clientSecret || !refreshToken)) {
    console.error('ERROR: Set DROPBOX_ACCESS_TOKEN or both DROPBOX_CLIENT_SECRET + DROPBOX_REFRESH_TOKEN in .env');
    process.exit(1);
  }

  // 2. Create client
  let dbx: Dropbox;
  if (accessToken) {
    dbx = new Dropbox({ accessToken, fetch: fetch as any });
    console.log('Using direct access token.\n');
  } else {
    const auth = new DropboxAuth({
      clientId,
      clientSecret,
      refreshToken,
      fetch: fetch as any,
    });
    dbx = new Dropbox({ auth, fetch: fetch as any });
    console.log('Using OAuth2 refresh token flow.\n');
  }

  // 3. Test: get account info
  try {
    const account = await dbx.usersGetCurrentAccount();
    console.log(`✓ Authenticated as: ${account.result.name.display_name} (${account.result.email})\n`);
  } catch (err: any) {
    console.error('✗ Authentication FAILED:', err?.error?.error_summary || err.message);
    process.exit(1);
  }

  // 4. Test: list /Analyses/RIJ
  try {
    const result = await dbx.filesListFolder({ path: '/Analyses/RIJ', limit: 10 });
    console.log('✓ /Analyses/RIJ accessible — contents:');
    for (const entry of result.result.entries) {
      console.log(`    ${entry['.tag'] === 'folder' ? '📁' : '📄'} ${entry.name}`);
    }
    console.log();
  } catch (err: any) {
    console.error('✗ Cannot list /Analyses/RIJ:', err?.error?.error_summary || err.message);
  }

  // 5. Test: list /analyses/rij/plans (source folder for part files)
  try {
    const result = await dbx.filesListFolder({ path: '/analyses/rij/plans', limit: 10 });
    console.log(`✓ /analyses/rij/plans accessible — ${result.result.entries.length} entries (showing first 10):`);
    for (const entry of result.result.entries.slice(0, 10)) {
      console.log(`    ${entry['.tag'] === 'folder' ? '📁' : '📄'} ${entry.name}`);
    }
    console.log();
  } catch (err: any) {
    console.error('✗ Cannot list /analyses/rij/plans:', err?.error?.error_summary || err.message);
  }

  // 6. Test: check if ID 13315 folder exists
  try {
    const result = await dbx.filesListFolder({ path: '/analyses/rij/plans/13315' });
    console.log(`✓ /analyses/rij/plans/13315 exists — ${result.result.entries.length} files:`);
    for (const entry of result.result.entries) {
      console.log(`    📄 ${entry.name}`);
    }
  } catch (err: any) {
    const summary = err?.error?.error_summary || '';
    if (summary.includes('path/not_found')) {
      console.log('⚠ /analyses/rij/plans/13315 not found (folder does not exist yet)');
    } else {
      console.error('✗ Error checking 13315:', summary || err.message);
    }
  }

  console.log('\n── Check complete ──');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
