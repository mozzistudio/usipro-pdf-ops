# Bug : l'app ne trouve JAMAIS les fichiers dans Dropbox

## Problème

App Node.js/TypeScript qui cherche des PDF/STEP dans Dropbox sous `/Analyses/RIJ/Plans/{partId}/`.
Erreur systématique : `Aucun fichier technique (PDF/STEP) trouvé pour les pièces: 13383`
**MAIS** le dossier `/Analyses/RIJ/Plans/13383/` existe dans Dropbox avec `020-LT0601-2.pdf` et `020-LT0601-2.stp` dedans.

Ca ne trouve JAMAIS les docs, pour aucune pièce, 100% reproductible.

## Stack

- Node 20, TypeScript, Express 4, `dropbox` SDK npm v10.34.0, `node-fetch` v2.7.0
- Auth : OAuth2 refresh token OU long-lived access token
- Déploiement Docker

## Flux de recherche (tous échouent)

1. `listFiles('/Analyses/RIJ/Plans/13383')` → path/not_found
2. Fallback : `findMatchingFolder('/Analyses/RIJ/Plans', '13383')` → liste le parent, cherche par nom → échoue
3. Fallback : `filesSearchV2('13383', '/Analyses/RIJ/Plans')` → échoue
4. Fallback : `listFilesRecursive(sourcePath)` → échoue

## Code critique

### `src/services/dropbox.ts` — Initialisation client

```typescript
import { Dropbox, DropboxAuth } from 'dropbox';
import fetch from 'node-fetch';

let dbxInstance: Dropbox | null = null;
let rootNamespaceId: string | null = null;

async function detectRootNamespace(dbx: Dropbox): Promise<string | null> {
  try {
    const account = await dbx.usersGetCurrentAccount();
    const rootInfo = account.result.root_info;
    return rootInfo.root_namespace_id;
  } catch (err: any) {
    return null; // ← erreur avalée silencieusement ?
  }
}

async function getClient(): Promise<Dropbox> {
  if (dbxInstance) return dbxInstance;

  let dbx: Dropbox;
  if (config.dropbox.accessToken) {
    dbx = new Dropbox({ accessToken: config.dropbox.accessToken, fetch: fetch as any });
  } else {
    const auth = new DropboxAuth({
      clientId: config.dropbox.clientId,
      clientSecret: config.dropbox.clientSecret,
      refreshToken: config.dropbox.refreshToken,
      fetch: fetch as any,
    });
    dbx = new Dropbox({ auth, fetch: fetch as any });
  }

  // Détection namespace et recréation client avec pathRoot
  const nsId = await detectRootNamespace(dbx);
  if (nsId) {
    rootNamespaceId = nsId;
    const pathRoot = JSON.stringify({ '.tag': 'root', root: nsId });
    // Recréation du client avec pathRoot
    dbx = new Dropbox({ accessToken: config.dropbox.accessToken, pathRoot, fetch: fetch as any });
  }

  dbxInstance = dbx;
  return dbxInstance;
}
```

### `src/services/dropbox.ts` — Fonctions de listing

```typescript
export async function listFiles(folderPath: string) {
  const dbx = await getClient();
  let result = await dbx.filesListFolder({ path: folderPath, recursive: false });
  // filtre uniquement e['.tag'] === 'file'
  // pagine avec has_more / filesListFolderContinue
}

export async function findMatchingFolder(parentPath: string, partId: string) {
  const entries = await listFolderEntries(parentPath); // liste TOUT le parent
  const folders = entries.filter(e => e.tag === 'folder');
  // cherche exact match, startsWith, contains (case-insensitive)
}

export async function searchByName(query: string, searchPath: string) {
  const dbx = await getClient();
  const result = await dbx.filesSearchV2({
    query, options: { path: searchPath, max_results: 20, filename_only: true }
  });
  // extrait (match.metadata as any)?.metadata
}
```

### `src/pipeline/ofPipeline.ts` — Extraction d'erreur

```typescript
} catch (err: any) {
  const errSummary = typeof err?.error === 'string'
    ? err.error
    : err?.error?.error_summary || '';
  // ↑ Est-ce que cette extraction correspond à la vraie structure d'erreur du SDK v10 ?

  if (typeof errSummary === 'string' && errSummary.includes('path/not_found')) {
    // fallbacks...
  } else {
    throw err; // ← si l'erreur n'est pas path/not_found, tout plante
  }
}
```

### `src/config.ts`

```typescript
export const config = {
  dropbox: {
    accessToken: process.env.DROPBOX_ACCESS_TOKEN || '',
    clientId: process.env.DROPBOX_CLIENT_ID || 'rp9ta3297qkrkoh',
    clientSecret: process.env.DROPBOX_CLIENT_SECRET || '',
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN || '',
  },
};
```

## Chemins Dropbox

```
SOURCE : /Analyses/RIJ/Plans/{partId}/          ← PDF et STP ici
DEST :   /Analyses/RIJ/Achats Externes/OF{of}/  ← dossier de sortie
```

## Hypothèses (à vérifier)

1. **Namespace Team/Business** : `root_namespace_id ≠ home_namespace_id`, le SDK cherche dans le mauvais espace. Le `pathRoot` ajouté est-il au bon format pour le SDK v10 ?
2. **Format pathRoot incorrect** : faut-il `{ '.tag': 'root', root: nsId }` ou `{ '.tag': 'namespace_id', namespace_id: nsId }` ?
3. **detectRootNamespace échoue silencieusement** : retourne `null`, client créé sans pathRoot
4. **App folder access** : si l'app Dropbox est en mode "App folder", tous les chemins sont relatifs à `/Apps/<app>/`
5. **Structure d'erreur SDK mal parsée** : `err.error` n'a peut-être pas la structure attendue dans le SDK v10
6. **Incompatibilité node-fetch v2 / SDK Dropbox v10**

## Mission

1. Identifie la cause racine exacte
2. Vérifie la doc du SDK `dropbox` npm v10 pour le format correct de `pathRoot` et la structure des erreurs
3. Donne le code corrigé complet (diff) pour `src/services/dropbox.ts` et `src/pipeline/ofPipeline.ts`
4. Écris un petit script diagnostic à exécuter pour confirmer le fix
