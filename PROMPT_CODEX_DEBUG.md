# Prompt pour Codex — Diagnostic complet : les documents ne sont JAMAIS trouvés dans Dropbox

## CONTEXTE DU PROBLÈME

Application Node.js/TypeScript (Express) qui automatise le traitement d'ordres de fabrication (OF).
Le pipeline cherche des fichiers techniques (PDF/STEP) dans Dropbox sous `/Analyses/RIJ/Plans/{partId}/`, puis les copie vers un dossier de sortie.

**Le problème** : la recherche de documents échoue SYSTÉMATIQUEMENT. L'erreur renvoyée est toujours :
```
Le traitement de l'OF 40943r a échoué: Aucun fichier technique (PDF/STEP) trouvé pour les pièces: 13383
```

**MAIS** : le dossier `/Analyses/RIJ/Plans/13383/` existe bel et bien dans Dropbox et contient :
- `020-LT0601-2.pdf`
- `020-LT0601-2.stp`

On le voit clairement dans l'interface web Dropbox. Pourtant l'API ne trouve jamais ces fichiers.

Le problème est **100% reproductible** — ça ne trouve JAMAIS les docs, pour aucune pièce.

---

## STACK TECHNIQUE

- **Runtime** : Node.js 20+
- **Langage** : TypeScript (strict)
- **Framework** : Express 4
- **SDK Dropbox** : `dropbox` npm v10.34.0
- **Auth Dropbox** : OAuth2 refresh token (`DROPBOX_CLIENT_SECRET` + `DROPBOX_REFRESH_TOKEN`) OU long-lived `DROPBOX_ACCESS_TOKEN`
- **Logging** : Pino
- **Déploiement** : Docker (Node 20 alpine)

---

## ARCHITECTURE DES FICHIERS

```
src/
├── index.ts              # Express server
├── config.ts             # Env vars (Dropbox tokens)
├── types/index.ts        # Interfaces TypeScript
├── utils/
│   ├── helpers.ts        # parseFormPayload, buildDropboxPaths, isPdf, isStep
│   └── logger.ts         # Pino logger
├── services/
│   ├── dropbox.ts        # TOUT le wrapper Dropbox SDK (513 lignes)
│   ├── documentGenerator.ts  # Génération PDF/DOCX locale
│   └── zip.ts            # Création ZIP
├── pipeline/
│   └── ofPipeline.ts     # Pipeline principal (238 lignes)
└── routes/
    └── webhook.ts        # Routes API (116 lignes)
```

---

## CODE SOURCE COMPLET DES FICHIERS CRITIQUES

### 1. `src/services/dropbox.ts` — Le wrapper Dropbox SDK complet

```typescript
import { Dropbox, DropboxAuth } from 'dropbox';
import fetch from 'node-fetch';
import { config } from '../config';
import { ofLogger } from '../utils/logger';

let dbxInstance: Dropbox | null = null;
let rootNamespaceId: string | null = null;

/** Reset the cached client (e.g. after an auth error) */
export function resetClient(): void {
  dbxInstance = null;
  rootNamespaceId = null;
}

/**
 * Detect the root namespace for the Dropbox account.
 * For Dropbox Business/Team accounts, the user's default namespace
 * may differ from the team's root namespace where shared folders live.
 * We need to set pathRoot to the root_namespace_id so API calls resolve
 * paths relative to the team space (where /Analyses/RIJ/Plans/ lives).
 */
async function detectRootNamespace(dbx: Dropbox): Promise<string | null> {
  const log = ofLogger('dropbox');
  try {
    const account = await dbx.usersGetCurrentAccount();
    const rootInfo = account.result.root_info;
    const rootNs = rootInfo.root_namespace_id;
    const homeNs = rootInfo.home_namespace_id;

    log.info(
      {
        rootNamespaceId: rootNs,
        homeNamespaceId: homeNs,
        rootInfoTag: (rootInfo as any)['.tag'],
        accountId: account.result.account_id,
        displayName: account.result.name?.display_name,
      },
      'Dropbox account info retrieved',
    );

    if (rootNs !== homeNs) {
      log.info(
        { rootNamespaceId: rootNs, homeNamespaceId: homeNs },
        'Team account detected — root and home namespaces differ. Will use root namespace for path resolution.',
      );
    }

    return rootNs;
  } catch (err: any) {
    log.warn({ err: err.message }, 'Failed to detect Dropbox root namespace — using default');
    return null;
  }
}

/** Get or create a Dropbox client, handling token refresh if OAuth2 is configured */
async function getClient(): Promise<Dropbox> {
  if (dbxInstance) return dbxInstance;

  const log = ofLogger('dropbox');

  let dbx: Dropbox;

  // If a long-lived access token is provided, use it directly
  if (config.dropbox.accessToken) {
    dbx = new Dropbox({
      accessToken: config.dropbox.accessToken,
      fetch: fetch as any,
    });
  } else if (config.dropbox.refreshToken && config.dropbox.clientSecret) {
    // Otherwise use OAuth2 refresh token flow
    log.info('Creating Dropbox client with OAuth2 refresh token flow');
    const auth = new DropboxAuth({
      clientId: config.dropbox.clientId,
      clientSecret: config.dropbox.clientSecret,
      refreshToken: config.dropbox.refreshToken,
      fetch: fetch as any,
    });
    dbx = new Dropbox({ auth, fetch: fetch as any });
  } else {
    throw new Error(
      'Dropbox auth not configured: set DROPBOX_ACCESS_TOKEN or both DROPBOX_CLIENT_SECRET and DROPBOX_REFRESH_TOKEN',
    );
  }

  // Detect root namespace and recreate client with pathRoot if needed
  const nsId = await detectRootNamespace(dbx);
  if (nsId) {
    rootNamespaceId = nsId;
    const pathRoot = JSON.stringify({ '.tag': 'root', root: nsId });
    log.info({ pathRoot }, 'Recreating Dropbox client with pathRoot for team namespace');

    if (config.dropbox.accessToken) {
      dbx = new Dropbox({
        accessToken: config.dropbox.accessToken,
        pathRoot,
        fetch: fetch as any,
      });
    } else {
      const auth = new DropboxAuth({
        clientId: config.dropbox.clientId,
        clientSecret: config.dropbox.clientSecret,
        refreshToken: config.dropbox.refreshToken,
        fetch: fetch as any,
      });
      dbx = new Dropbox({ auth, pathRoot, fetch: fetch as any });
    }
  }

  dbxInstance = dbx;
  return dbxInstance;
}

export async function createFolder(path: string): Promise<string> {
  const dbx = await getClient();
  const log = ofLogger('dropbox');
  try {
    const result = await dbx.filesCreateFolderV2({ path, autorename: false });
    const actualPath = result.result.metadata.path_display || path;
    log.info({ path: actualPath }, 'Folder created');
    return actualPath;
  } catch (err: any) {
    if (err?.error?.error_summary?.includes('path/conflict/folder')) {
      log.info({ path }, 'Folder already exists — reusing');
      return path;
    }
    throw err;
  }
}

export async function listFiles(
  folderPath: string,
): Promise<Array<{ name: string; pathLower: string; pathDisplay: string }>> {
  const dbx = await getClient();
  const allEntries: Array<{ name: string; pathLower: string; pathDisplay: string }> = [];

  let result = await dbx.filesListFolder({ path: folderPath, recursive: false });

  for (const e of result.result.entries) {
    if (e['.tag'] === 'file') {
      allEntries.push({
        name: e.name,
        pathLower: e.path_lower || '',
        pathDisplay: e.path_display || '',
      });
    }
  }

  while (result.result.has_more) {
    result = await dbx.filesListFolderContinue({ cursor: result.result.cursor });
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

export async function listFolderEntries(
  folderPath: string,
): Promise<Array<{ tag: string; name: string; pathLower: string; pathDisplay: string }>> {
  const dbx = await getClient();
  const log = ofLogger('dropbox');
  const allEntries: Array<{ tag: string; name: string; pathLower: string; pathDisplay: string }> = [];

  let result = await dbx.filesListFolder({ path: folderPath, recursive: false });
  let pageCount = 1;

  for (const e of result.result.entries) {
    allEntries.push({
      tag: e['.tag'],
      name: e.name,
      pathLower: e.path_lower || '',
      pathDisplay: e.path_display || '',
    });
  }
  log.info({ folderPath, page: pageCount, entriesInPage: result.result.entries.length, hasMore: result.result.has_more }, 'listFolderEntries page loaded');

  while (result.result.has_more) {
    pageCount++;
    result = await dbx.filesListFolderContinue({ cursor: result.result.cursor });
    for (const e of result.result.entries) {
      allEntries.push({
        tag: e['.tag'],
        name: e.name,
        pathLower: e.path_lower || '',
        pathDisplay: e.path_display || '',
      });
    }
    log.info({ folderPath, page: pageCount, entriesInPage: result.result.entries.length, hasMore: result.result.has_more }, 'listFolderEntries page loaded');
  }

  log.info({ folderPath, totalEntries: allEntries.length, totalPages: pageCount }, 'listFolderEntries completed');
  return allEntries;
}

export async function copyFile(fromPath: string, toPath: string): Promise<void> {
  const dbx = await getClient();
  const log = ofLogger('dropbox');
  try {
    await dbx.filesCopyV2({ from_path: fromPath, to_path: toPath, autorename: false });
  } catch (err: any) {
    if (err?.error?.error_summary?.includes('to/conflict/file')) {
      log.info({ toPath }, 'Destination file exists — overwriting');
      await dbx.filesDeleteV2({ path: toPath });
      await dbx.filesCopyV2({ from_path: fromPath, to_path: toPath, autorename: false });
    } else {
      throw err;
    }
  }
}

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
    if (err?.error?.error_summary?.startsWith('shared_link_already_exists')) {
      const existing = await dbx.sharingListSharedLinks({ path, direct_only: true });
      if (existing.result.links.length > 0) return existing.result.links[0].url;
    }
    throw err;
  }
}

export async function uploadFile(path: string, contents: Buffer): Promise<void> {
  const dbx = await getClient();
  const LARGE_FILE_THRESHOLD = 150 * 1024 * 1024;

  if (contents.length <= LARGE_FILE_THRESHOLD) {
    await dbx.filesUpload({ path, contents, mode: { '.tag': 'overwrite' }, autorename: true });
  } else {
    const CHUNK_SIZE = 8 * 1024 * 1024;
    let offset = 0;
    const startResult = await dbx.filesUploadSessionStart({ contents: contents.subarray(0, CHUNK_SIZE), close: false });
    const sessionId = startResult.result.session_id;
    offset = CHUNK_SIZE;
    while (offset < contents.length - CHUNK_SIZE) {
      await dbx.filesUploadSessionAppendV2({ cursor: { session_id: sessionId, offset }, contents: contents.subarray(offset, offset + CHUNK_SIZE), close: false });
      offset += CHUNK_SIZE;
    }
    await dbx.filesUploadSessionFinish({ cursor: { session_id: sessionId, offset }, commit: { path, mode: { '.tag': 'overwrite' }, autorename: true }, contents: contents.subarray(offset) });
  }
}

export async function listFilesRecursive(
  folderPath: string,
): Promise<Array<{ name: string; pathLower: string; pathDisplay: string }>> {
  const dbx = await getClient();
  const allEntries: Array<{ name: string; pathLower: string; pathDisplay: string }> = [];

  let result = await dbx.filesListFolder({ path: folderPath, recursive: true });
  for (const e of result.result.entries) {
    if (e['.tag'] === 'file') {
      allEntries.push({ name: e.name, pathLower: e.path_lower || '', pathDisplay: e.path_display || '' });
    }
  }
  while (result.result.has_more) {
    result = await dbx.filesListFolderContinue({ cursor: result.result.cursor });
    for (const e of result.result.entries) {
      if (e['.tag'] === 'file') {
        allEntries.push({ name: e.name, pathLower: e.path_lower || '', pathDisplay: e.path_display || '' });
      }
    }
  }
  return allEntries;
}

export async function findMatchingFolder(parentPath: string, partId: string): Promise<string | null> {
  const log = ofLogger('dropbox');
  const entries = await listFolderEntries(parentPath);
  const folders = entries.filter(e => e.tag === 'folder');
  const lowerPartId = partId.toLowerCase();

  log.info({ parentPath, partId, totalEntries: entries.length, folderCount: folders.length, sampleFolders: folders.slice(0, 10).map(f => f.name) }, 'findMatchingFolder: listed parent folder');

  const exact = folders.find(f => f.name.toLowerCase() === lowerPartId);
  if (exact) {
    log.info({ partId, matchedName: exact.name, matchedPath: exact.pathDisplay }, 'findMatchingFolder: exact match found');
    return exact.pathDisplay;
  }

  const startsWith = folders.filter(f => f.name.toLowerCase().startsWith(lowerPartId));
  if (startsWith.length === 1) return startsWith[0].pathDisplay;
  if (startsWith.length > 1) {
    log.warn({ partId, matches: startsWith.map(f => f.name) }, 'Multiple folders start with partId — using first match');
    return startsWith[0].pathDisplay;
  }

  const contains = folders.filter(f => f.name.toLowerCase().includes(lowerPartId));
  if (contains.length === 1) return contains[0].pathDisplay;
  if (contains.length > 1) {
    log.warn({ partId, matches: contains.map(f => f.name) }, 'Multiple folders contain partId — using first match');
    return contains[0].pathDisplay;
  }

  return null;
}

export async function searchByName(
  query: string,
  searchPath: string,
): Promise<Array<{ tag: string; name: string; pathLower: string; pathDisplay: string }>> {
  const dbx = await getClient();
  const log = ofLogger('dropbox');

  const result = await dbx.filesSearchV2({
    query,
    options: { path: searchPath, max_results: 20, file_status: { '.tag': 'active' }, filename_only: true },
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

export async function downloadFile(path: string): Promise<Buffer> {
  const dbx = await getClient();
  const result = await dbx.filesDownload({ path });
  return (result.result as any).fileBinary as Buffer;
}

export async function deletePath(path: string): Promise<void> {
  const dbx = await getClient();
  await dbx.filesDeleteV2({ path });
}

export async function getAccountInfo(): Promise<Record<string, unknown>> {
  const dbx = await getClient();
  const account = await dbx.usersGetCurrentAccount();
  const rootInfo = account.result.root_info;
  return {
    accountId: account.result.account_id,
    displayName: account.result.name?.display_name,
    email: account.result.email,
    rootNamespaceId: rootInfo.root_namespace_id,
    homeNamespaceId: rootInfo.home_namespace_id,
    rootInfoTag: (rootInfo as any)['.tag'],
    configuredPathRoot: rootNamespaceId,
    isTeamAccount: rootInfo.root_namespace_id !== rootInfo.home_namespace_id,
  };
}
```

### 2. `src/pipeline/ofPipeline.ts` — Le pipeline principal

```typescript
import JSZip from 'jszip';
import { OFData, PipelineResult } from '../types';
import { buildDropboxPaths, getExtension, isPdf, isStep } from '../utils/helpers';
import { ofLogger } from '../utils/logger';
import * as dropboxService from '../services/dropbox';
import * as documentGenerator from '../services/documentGenerator';
import * as zipService from '../services/zip';

export async function runPipeline(ofData: OFData): Promise<PipelineResult> {
  const { ofNumber, parts } = ofData;
  const log = ofLogger(ofNumber);
  const paths = buildDropboxPaths(ofNumber);

  // Step 1: Create Dropbox folder structure
  log.info('Step 1: Creating Dropbox folder structure');
  await dropboxService.createFolder(paths.main);
  await dropboxService.createFolder(paths.nm);
  await dropboxService.createFolder(paths.dp);
  log.info({ paths }, 'Folder structure created');

  // Step 2: Search & copy technical files for every part
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
      log.warn({ partId, sourcePath, errStatus: err?.status, errSummary, errMessage: err?.message }, 'Direct folder listing failed');

      if (typeof errSummary === 'string' && errSummary.includes('path/not_found')) {
        // Fallback 1: folder name matching in parent
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
          log.warn({ partId, errMessage: fallbackErr?.message, errStatus: fallbackErr?.status, errSummary: fallbackErr?.error?.error_summary }, 'Fallback folder search failed');
        }

        // Fallback 2: Dropbox search API
        if (files.length === 0) {
          log.info({ partId, plansBasePath }, 'Trying fallback: Dropbox search API');
          try {
            const searchResults = await dropboxService.searchByName(partId, plansBasePath);
            log.info({ partId, searchResultCount: searchResults.length, searchResults: searchResults.map(r => ({ tag: r.tag, name: r.name, path: r.pathDisplay })) }, 'Dropbox search API results');

            const matchedFolder = searchResults.find(
              r => r.tag === 'folder' && r.name.toLowerCase() === partId.toLowerCase(),
            );
            if (matchedFolder) {
              sourcePath = matchedFolder.pathDisplay;
              files = await dropboxService.listFiles(sourcePath);
            } else {
              const techFiles = searchResults.filter(
                r => r.tag === 'file' && (isPdf(r.name) || isStep(r.name)),
              );
              if (techFiles.length > 0) {
                files = techFiles.map(f => ({ name: f.name, pathLower: f.pathLower, pathDisplay: f.pathDisplay }));
              }
            }
          } catch (searchErr: any) {
            log.warn({ partId, errMessage: searchErr?.message, errStatus: searchErr?.status }, 'Dropbox search API fallback failed');
          }
        }

        if (files.length === 0) {
          log.warn({ partId, sourcePath }, 'All search methods failed — skipping part');
          missingParts.push(partId);
          continue;
        }
      } else {
        log.error({ partId, sourcePath, errStatus: err?.status, errSummary, errMessage: err?.message, errBody: err?.error }, 'Unexpected Dropbox error during folder listing');
        throw err;
      }
    }

    // Recursive search fallback
    if (files.length === 0) {
      log.info({ partId, sourcePath }, 'No direct files — trying recursive search in subfolders');
      try {
        files = await dropboxService.listFilesRecursive(sourcePath);
      } catch (recErr: any) {
        log.warn({ partId, sourcePath, errMessage: recErr?.message }, 'Recursive search failed');
      }
    }

    if (files.length === 0) {
      log.warn({ partId, sourcePath }, 'Part folder exists but has no files — skipping');
      missingParts.push(partId);
      continue;
    }

    for (const file of files) {
      const ext = getExtension(file.name);
      if (isPdf(file.name)) {
        const destPath = `${paths.nm}/${partId}.pdf`;
        await dropboxService.copyFile(file.pathDisplay, destPath);
        copiedFiles++;
      } else if (isStep(file.name)) {
        const destPath = `${paths.dp}/${partId}.${ext}`;
        await dropboxService.copyFile(file.pathDisplay, destPath);
        copiedFiles++;
      }
    }
  }

  // Abort if no technical files were found
  if (copiedFiles === 0) {
    log.warn({ missingParts }, 'No technical files found for any part — aborting pipeline');
    await Promise.all([
      dropboxService.deletePath(paths.nm).catch(() => {}),
      dropboxService.deletePath(paths.dp).catch(() => {}),
      dropboxService.deletePath(paths.main).catch(() => {}),
    ]);
    throw new Error(
      `Aucun fichier technique (PDF/STEP) trouvé pour les pièces: ${missingParts.join(', ')}`,
    );
  }

  // Steps 3-8: ZIP, PDF/DOCX generation, upload, shared link...
  // (ces étapes ne sont jamais atteintes car le pipeline échoue à l'étape 2)
}
```

### 3. `src/config.ts`

```typescript
import dotenv from 'dotenv';
dotenv.config();

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  port: parseInt(optionalEnv('PORT', '3000'), 10),
  dropbox: {
    accessToken: process.env.DROPBOX_ACCESS_TOKEN || '',
    clientId: process.env.DROPBOX_CLIENT_ID || 'rp9ta3297qkrkoh',
    clientSecret: process.env.DROPBOX_CLIENT_SECRET || '',
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN || '',
  },
} as const;
```

### 4. `src/utils/helpers.ts`

```typescript
import { FormPayload, OFData } from '../types';

export function parseFormPayload(payload: FormPayload): OFData {
  const ofNumber = (payload.of || '').trim();
  if (!ofNumber) throw new Error('Numéro OF manquant');
  const parts = (payload.parts || []).filter(p => p.id && p.id.trim());
  if (parts.length === 0) throw new Error('Au moins une pièce avec un ID est requise');
  return { ofNumber, parts };
}

export function buildDropboxPaths(ofNumber: string) {
  const base = '/Analyses/RIJ/Achats Externes';
  const main = `${base}/OF${ofNumber}`;
  return {
    main,
    nm: `${main}/NM${ofNumber}`,
    dp: `${main}/DP${ofNumber}`,
  };
}

export function isPdf(filename: string): boolean { return /\.pdf$/i.test(filename); }
export function isStep(filename: string): boolean { return /\.(stp|step)$/i.test(filename); }
export function getExtension(filename: string): string {
  const match = filename.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}
```

### 5. `src/types/index.ts`

```typescript
export interface Part { id: string; material: string; quantity: string; processing: string; comment: string; }
export interface FormPayload { of: string; parts: Part[]; }
export interface OFData { ofNumber: string; parts: Part[]; }
export interface PipelineResult { ofNumber: string; dropboxLink: string; missingParts: string[]; zipBase64: string; }
```

### 6. `test/dropbox-check.ts` — Le script de test qui NE gère PAS non plus le namespace

```typescript
// Ce script de test crée aussi un client Dropbox SANS pathRoot,
// donc il a probablement le même problème que l'application principale.
// Si on l'exécute, il ne trouvera probablement pas /Analyses/RIJ/Plans non plus.

import { Dropbox, DropboxAuth } from 'dropbox';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  // ... crée le client SANS pathRoot ni detectRootNamespace ...
  let dbx: Dropbox;
  if (accessToken) {
    dbx = new Dropbox({ accessToken, fetch: fetch as any });
  } else {
    const auth = new DropboxAuth({ clientId, clientSecret, refreshToken, fetch: fetch as any });
    dbx = new Dropbox({ auth, fetch: fetch as any });
  }

  // Test: list /Analyses/RIJ
  const result = await dbx.filesListFolder({ path: '/Analyses/RIJ', limit: 10 });
  // Test: list /analyses/rij/plans
  const result2 = await dbx.filesListFolder({ path: '/analyses/rij/plans', limit: 10 });
  // Test: check if ID 13315 folder exists
  const result3 = await dbx.filesListFolder({ path: '/analyses/rij/plans/13315' });
}
```

---

## CHEMINS DROPBOX

```
ENTRÉE (source des plans) :
  /Analyses/RIJ/Plans/{partId}/           ← contient les .pdf et .stp/.step

SORTIE (dossier de l'OF) :
  /Analyses/RIJ/Achats Externes/OF{ofNumber}/
  /Analyses/RIJ/Achats Externes/OF{ofNumber}/NM{ofNumber}/   ← PDFs copiés ici
  /Analyses/RIJ/Achats Externes/OF{ofNumber}/DP{ofNumber}/   ← STEP copiés ici
```

---

## CE QUI A ÉTÉ TENTÉ JUSQU'ICI (sans succès)

1. **Recherche directe par chemin** : `listFiles('/Analyses/RIJ/Plans/13383')` → échoue
2. **Fallback par nom de dossier** : `findMatchingFolder('/Analyses/RIJ/Plans', '13383')` → liste le parent, cherche le dossier par nom → échoue aussi
3. **Fallback par API search Dropbox** : `filesSearchV2('13383', '/Analyses/RIJ/Plans')` → ajouté récemment, probablement échoue aussi
4. **Recherche récursive** : `listFilesRecursive(sourcePath)` → échoue
5. **Auto-détection du root namespace** : `detectRootNamespace()` → ajouté récemment, utilise `usersGetCurrentAccount()` pour récupérer `root_namespace_id` et recréer le client avec `pathRoot`

---

## HYPOTHÈSES SUR LA CAUSE RACINE

### Hypothèse 1 : Namespace Dropbox Business/Team (la plus probable)
Pour les comptes Dropbox Business, le SDK utilise par défaut le namespace "home" de l'utilisateur connecté. Les dossiers partagés de l'équipe sont dans le "root namespace" qui est DIFFÉRENT. L'API ne voit pas les fichiers car elle cherche dans le mauvais namespace.

**Vérification** : Si `root_namespace_id !== home_namespace_id`, c'est un compte Team et il FAUT utiliser `pathRoot`.

**Question** : Est-ce que l'implémentation actuelle de `detectRootNamespace` + `pathRoot` dans `getClient()` est correcte ? Y a-t-il un bug dans la façon dont le `pathRoot` est passé au SDK Dropbox v10.34.0 ?

### Hypothèse 2 : Format du pathRoot incorrect
Le SDK Dropbox v10 attend `pathRoot` comme un header `Dropbox-API-Path-Root`. Le format correct est-il bien `JSON.stringify({ '.tag': 'root', root: nsId })` ? Faut-il utiliser `{ '.tag': 'namespace_id', namespace_id: nsId }` à la place ?

### Hypothèse 3 : Erreur silencieuse dans detectRootNamespace
Si `detectRootNamespace` échoue (catch), il retourne `null` et le client est créé SANS pathRoot. Les erreurs pourraient être avalées silencieusement.

### Hypothèse 4 : Problème avec le SDK Dropbox v10 et node-fetch
Le SDK `dropbox@10.34.0` avec `node-fetch@2.7.0` pourrait avoir des incompatibilités. Les erreurs SDK pourraient avoir une structure différente de celle attendue.

### Hypothèse 5 : Token d'accès avec scope limité
Si l'app Dropbox a été créée avec "App folder" access au lieu de "Full Dropbox" access, toutes les opérations de chemin sont relatives au dossier de l'app (`/Apps/<app_name>/`), pas à la racine du Dropbox.

### Hypothèse 6 : Structure d'erreur Dropbox SDK mal parsée
Le code extrait `err?.error?.error_summary` mais la structure pourrait être différente dans certaines versions du SDK, causant le fallback à ne pas se déclencher correctement.

---

## TA MISSION

1. **Analyse chaque hypothèse** et détermine laquelle est la cause racine
2. **Vérifie le code de A à Z** pour trouver tout bug, edge case, ou problème de logique
3. **Propose des corrections concrètes** avec le code exact à modifier
4. **Vérifie la documentation Dropbox SDK v10** pour confirmer :
   - Le format correct de `pathRoot` (JSON exact attendu par le SDK)
   - La structure des erreurs retournées par le SDK
   - Comment gérer correctement les namespaces Team/Business
5. **Écris un script de diagnostic** qui peut être exécuté pour identifier précisément le problème (namespace, scope, path root, etc.)
6. **Corrige l'ensemble du code** pour que la recherche de documents fonctionne, en couvrant tous les cas :
   - Compte personnel Dropbox
   - Compte Business/Team Dropbox
   - App folder vs Full Dropbox access
   - Token expiré / refresh automatique

---

## RÉSULTAT ATTENDU

Un diff complet des fichiers à modifier avec le code corrigé, testé et fonctionnel, plus une explication claire de la cause racine identifiée.
