import { Part, OFDropboxPaths } from '../types';

export interface PipelineState {
  ofNumber: string;
  resolvedOF: string;
  parts: Part[];
  paths: OFDropboxPaths;
  pdfs: Array<{ partId: string; originalBase64: string; anonymizedBase64: string }>;
  missingParts: string[];
  createdAt: number;
}

const store = new Map<string, PipelineState>();

export function saveState(sessionId: string, state: PipelineState): void {
  store.set(sessionId, state);
}

export function getState(sessionId: string): PipelineState | undefined {
  return store.get(sessionId);
}

export function deleteState(sessionId: string): void {
  store.delete(sessionId);
}

// Cleanup automatique toutes les 5 minutes : supprimer les sessions > 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of store) {
    if (now - state.createdAt > 30 * 60 * 1000) store.delete(id);
  }
}, 5 * 60 * 1000);
