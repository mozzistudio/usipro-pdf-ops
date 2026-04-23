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

/**
 * A PDF candidate whose bytes are already in memory (downloaded once during
 * the initial Dropbox scan). Kept alive between the submit and the user
 * selection so we don't re-download on resume.
 */
export interface CandidateDoc {
  name: string;
  pathDisplay: string;
  pdfBytes: Buffer;
}

/** One entry per partId whose Dropbox folder contained PDFs. */
export interface PartDocs {
  partId: string;
  candidates: CandidateDoc[];
  /** Pre-selected candidate index (Claude picked with 'high' confidence). */
  selectedIndex: number | null;
}

/**
 * State saved when Phase 1 pauses mid-flight waiting for the user to pick a
 * plan among ambiguous candidates.
 */
export interface PendingSelectionState {
  kind: 'pending_selection';
  ofNumber: string;
  resolvedOF: string;
  parts: Part[];
  paths: OFDropboxPaths;
  partDocs: PartDocs[];
  missingParts: string[];
  createdAt: number;
}

type AnyState = (PipelineState & { kind?: 'pipeline' }) | PendingSelectionState;

const store = new Map<string, AnyState>();

export function saveState(sessionId: string, state: PipelineState): void {
  store.set(sessionId, { ...state, kind: 'pipeline' });
}

export function getState(sessionId: string): PipelineState | undefined {
  const s = store.get(sessionId);
  if (!s || (s as PendingSelectionState).kind === 'pending_selection') return undefined;
  return s as PipelineState;
}

export function savePendingSelection(sessionId: string, state: PendingSelectionState): void {
  store.set(sessionId, state);
}

export function getPendingSelection(sessionId: string): PendingSelectionState | undefined {
  const s = store.get(sessionId);
  if (!s || (s as PendingSelectionState).kind !== 'pending_selection') return undefined;
  return s as PendingSelectionState;
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
