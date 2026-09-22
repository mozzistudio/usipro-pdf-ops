/**
 * STEP before/after comparison — the evidence behind `anonymizeStep()`.
 *
 * Produces everything the comparison page needs to judge whether a STEP file
 * was actually cleaned:
 *   - the FILE_NAME fields, raw, before and after
 *   - a line diff of the HEADER section (the only part the anonymizer rewrites)
 *   - proof that the DATA section (geometry) is byte-identical
 *   - a scan for identifying strings that survived anywhere in the file
 *
 * The last point is the one that matters in practice: `anonymizeStep()` only
 * clears four HEADER fields, so a client name sitting in FILE_DESCRIPTION, in a
 * PRODUCT entity or in an exported file path goes straight through untouched.
 */

import {
  anonymizeStep,
  FILE_NAME_FIELDS,
  parseFileNameFields,
  splitHeaderData,
} from './stepAnonymizer';
import { SIGS } from './pdfAnonymizer';

/** One FILE_NAME argument, before and after. */
export interface FieldDiff {
  key: string;
  label: string;
  /** True when the anonymizer is supposed to clear this field. */
  shouldClear: boolean;
  before: string;
  after: string;
  changed: boolean;
  /**
   * True when `after` holds no value. Computed here rather than in the page
   * because real STEP files carry inline comments — `/* author *\/ ('')` is an
   * empty field, and a naive string check reads it as populated.
   */
  isEmptyAfter: boolean;
}

export interface DiffLine {
  type: 'ctx' | 'del' | 'add';
  beforeNo: number | null;
  afterNo: number | null;
  text: string;
}

/** Identifying strings found in a file, grouped by the exact match. */
export interface ResidualGroup {
  kind: 'client' | 'path' | 'cadfile' | 'email' | 'url';
  label: string;
  match: string;
  count: number;
  samples: Array<{ lineNo: number; excerpt: string }>;
  /** Where the matches sit — header, data, or both. */
  section: 'header' | 'data' | 'both';
}

export interface StepComparison {
  fileName: string;
  sizeBefore: number;
  sizeAfter: number;
  /** False when the file has no parsable FILE_NAME entry. */
  parsed: boolean;
  fields: FieldDiff[];
  headerBefore: string;
  headerAfter: string;
  diff: DiffLine[];
  diffTruncated: boolean;
  /** True when every byte after `DATA;` is unchanged. */
  geometryUntouched: boolean;
  residualsBefore: ResidualGroup[];
  residualsAfter: ResidualGroup[];
  /** Matches present before and gone after — what the anonymizer actually removed. */
  removed: string[];
  residualsTruncated: boolean;
  /** Null when the file is too large to ship back inline. */
  anonymizedBase64: string | null;
}

/** Above this, the anonymized file is not returned for download. */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;
/** Header diffs beyond this many lines are cut off. */
const MAX_DIFF_LINES = 400;
/** Distinct residual matches reported per file. */
const MAX_RESIDUAL_GROUPS = 60;

export function compareStep(fileName: string, original: Buffer): StepComparison {
  const anonymized = anonymizeStep(original);

  const textBefore = original.toString('latin1');
  const textAfter = anonymized.toString('latin1');

  const splitBefore = splitHeaderData(textBefore);
  const splitAfter = splitHeaderData(textAfter);

  const argsBefore = parseFileNameFields(textBefore);
  const argsAfter = parseFileNameFields(textAfter);

  const fields: FieldDiff[] = FILE_NAME_FIELDS.map((f) => {
    const before = argsBefore?.[f.key] ?? '';
    const after = argsAfter?.[f.key] ?? '';
    return {
      key: f.key,
      label: f.label,
      shouldClear: f.cleared,
      before,
      after,
      changed: before !== after,
      isEmptyAfter: isBlankToken(after),
    };
  });

  const diffResult = diffLines(
    splitBefore.header.split(/\r?\n/),
    splitAfter.header.split(/\r?\n/),
  );

  const residualsBefore = scanResiduals(textBefore, splitBefore.header.length);
  const residualsAfter = scanResiduals(textAfter, splitAfter.header.length);
  const afterMatches = new Set(residualsAfter.groups.map((g) => g.match.toLowerCase()));
  const removed = residualsBefore.groups
    .filter((g) => !afterMatches.has(g.match.toLowerCase()))
    .map((g) => g.match);

  return {
    fileName,
    sizeBefore: original.length,
    sizeAfter: anonymized.length,
    parsed: argsBefore !== null,
    fields,
    headerBefore: splitBefore.header,
    headerAfter: splitAfter.header,
    diff: diffResult.lines,
    diffTruncated: diffResult.truncated,
    geometryUntouched: splitBefore.data === splitAfter.data,
    residualsBefore: residualsBefore.groups,
    residualsAfter: residualsAfter.groups,
    removed,
    residualsTruncated: residualsBefore.truncated || residualsAfter.truncated,
    anonymizedBase64:
      anonymized.length <= MAX_INLINE_BYTES ? anonymized.toString('base64') : null,
  };
}


/**
 * True when a raw STEP token carries no value: '' or ('') or (), once inline
 * `/* ... *\/` comments and whitespace are removed. CAD exporters routinely
 * annotate each FILE_NAME argument with a comment naming the field.
 */
function isBlankToken(token: string): boolean {
  const t = String(token || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '');
  return t === '' || t === "''" || t === "('')" || t === '()';
}

// ── Diff ──────────────────────────────────────────────────────────

/**
 * Line diff via a plain LCS table. Only ever runs on the HEADER section, which
 * is a few dozen lines, so the O(n·m) table is not a concern.
 */
function diffLines(a: string[], b: string[]): { lines: DiffLine[]; truncated: boolean } {
  // Guard against a pathological header (a file with no DATA; section at all).
  if (a.length > 2000 || b.length > 2000) {
    return {
      lines: [
        ...a.slice(0, MAX_DIFF_LINES / 2).map((text, i): DiffLine => ({ type: 'del', beforeNo: i + 1, afterNo: null, text })),
        ...b.slice(0, MAX_DIFF_LINES / 2).map((text, i): DiffLine => ({ type: 'add', beforeNo: null, afterNo: i + 1, text })),
      ],
      truncated: true,
    };
  }

  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: 'ctx', beforeNo: i + 1, afterNo: j + 1, text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: 'del', beforeNo: i + 1, afterNo: null, text: a[i] });
      i++;
    } else {
      lines.push({ type: 'add', beforeNo: null, afterNo: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) lines.push({ type: 'del', beforeNo: i + 1, afterNo: null, text: a[i++] });
  while (j < m) lines.push({ type: 'add', beforeNo: null, afterNo: j + 1, text: b[j++] });

  const truncated = lines.length > MAX_DIFF_LINES;
  return { lines: truncated ? lines.slice(0, MAX_DIFF_LINES) : lines, truncated };
}

// ── Residual identifier scan ──────────────────────────────────────

/**
 * CAD vendor names that appear in SIGS but are not clients. `anonymizeStep()`
 * deliberately preserves the preprocessor and originating_system fields, so
 * flagging these would bury the real findings under noise.
 */
const NOT_CLIENTS = new Set(['SOLIDWORKS']);

/** Every client signature the PDF anonymizer knows about, flattened. */
const CLIENT_WORDS = Array.from(
  new Set(Object.values(SIGS).flat().map((w) => w.toUpperCase())),
).filter((w) => w.length >= 4 && !NOT_CLIENTS.has(w));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATTERNS: Array<{ kind: ResidualGroup['kind']; label: string; re: RegExp }> = [
  {
    kind: 'client',
    label: 'Nom de client connu',
    re: new RegExp(`\\b(?:${CLIENT_WORDS.map(escapeRe).join('|')})\\b`, 'gi'),
  },
  {
    kind: 'path',
    label: 'Chemin de fichier',
    re: /(?:[A-Za-z]:\\|\\\\[A-Za-z0-9_-]+\\)[^'"\r\n]{0,160}/g,
  },
  {
    kind: 'cadfile',
    label: 'Nom de fichier CAO',
    re: /[A-Za-z0-9_.\- ]{1,80}\.(?:sldprt|sldasm|catpart|catproduct|prt|asm|ipt|iam|par|psm|x_t|x_b|dwg|dxf|stp|step)\b/gi,
  },
  { kind: 'email', label: 'Adresse e-mail', re: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g },
  { kind: 'url', label: 'URL', re: /https?:\/\/[^\s'"<>]+/gi },
];

/**
 * Find identifying strings anywhere in the file, grouped by exact match so a
 * name repeated across thousands of entities reads as one finding.
 *
 * `headerLength` is the byte offset where the DATA section starts, used to say
 * whether a match sits in the header, in the geometry, or in both.
 */
function scanResiduals(
  text: string,
  headerLength: number,
): { groups: ResidualGroup[]; truncated: boolean } {
  const lineStarts = buildLineStarts(text);
  const byMatch = new Map<string, ResidualGroup>();
  let truncated = false;

  for (const p of PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const raw = m[0].trim();
      if (!raw) continue;

      const key = `${p.kind}:${raw.toLowerCase()}`;
      let group = byMatch.get(key);
      if (!group) {
        if (byMatch.size >= MAX_RESIDUAL_GROUPS) {
          truncated = true;
          break;
        }
        group = {
          kind: p.kind,
          label: p.label,
          match: raw,
          count: 0,
          samples: [],
          section: m.index < headerLength ? 'header' : 'data',
        };
        byMatch.set(key, group);
      }

      group.count++;
      const section = m.index < headerLength ? 'header' : 'data';
      if (group.section !== section) group.section = 'both';
      if (group.samples.length < 3) {
        group.samples.push({
          lineNo: lineNumberAt(lineStarts, m.index),
          excerpt: excerptAt(text, m.index, m[0].length),
        });
      }
    }
  }

  const groups = Array.from(byMatch.values()).sort((a, b) => b.count - a.count);
  return { groups, truncated };
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  let idx = text.indexOf('\n');
  while (idx !== -1) {
    starts.push(idx + 1);
    idx = text.indexOf('\n', idx + 1);
  }
  return starts;
}

function lineNumberAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/[\r\n]+/g, ' ') + (end < text.length ? '…' : '');
}
