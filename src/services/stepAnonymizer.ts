/**
 * STEP file anonymizer (ISO 10303-21)
 *
 * Clears proprietary metadata from the HEADER section only.
 * The DATA section (geometry) is never touched.
 *
 * Cleared fields in FILE_NAME:
 *   - file name    (arg 1) → ''
 *   - author       (arg 3) → ('')
 *   - organization (arg 4) → ('')
 *   - authorization (arg 7) → ''
 *
 * Preserved fields:
 *   - timestamp          (arg 2) — useful for traceability
 *   - preprocessor       (arg 5) — CAD software name, not sensitive
 *   - originating_system (arg 6) — CAD software name, not sensitive
 */
export function anonymizeStep(buffer: Buffer): Buffer {
  const text = buffer.toString('latin1');

  // Detect line endings to preserve them
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  const output: string[] = [];
  let collecting = false;
  let block = '';

  for (const line of lines) {
    if (!collecting && /^\s*FILE_NAME\s*\(/i.test(line)) {
      block = line;
      if (isClosed(block)) {
        output.push(rewriteFileName(block));
        block = '';
      } else {
        collecting = true;
      }
      continue;
    }

    if (collecting) {
      block += eol + line;
      if (isClosed(block)) {
        output.push(rewriteFileName(block));
        block = '';
        collecting = false;
      }
      continue;
    }

    output.push(line);
  }

  // Safety: if FILE_NAME was never closed (malformed), flush as-is
  if (block) output.push(block);

  return Buffer.from(output.join(eol), 'latin1');
}

/** True when the accumulated block ends with ); (statement terminator) */
function isClosed(s: string): boolean {
  return /\)\s*;[\s]*$/.test(s.trimEnd());
}

/**
 * Rewrite a FILE_NAME(...); block with sensitive fields cleared.
 *
 * STEP FILE_NAME arguments (ISO 10303-21 §8.2.2):
 *   1  name                 STRING
 *   2  time_stamp           DATE_AND_TIME
 *   3  author               LIST OF STRING  → ('...')
 *   4  organization         LIST OF STRING  → ('...')
 *   5  preprocessor_version STRING
 *   6  originating_system   STRING
 *   7  authorization        STRING
 */
function rewriteFileName(block: string): string {
  // Flatten to single line for uniform processing
  const flat = block.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Extract each argument using a simple sequential parser
  const inner = extractInner(flat);
  if (!inner) return block; // can't parse — leave untouched

  const args = parseStepArgs(inner);
  if (args.length < 7) return block;

  const [, timestamp, , , prep, orig] = args;

  return `FILE_NAME('', ${timestamp}, (''), (''), ${prep}, ${orig}, '');`;
}

/**
 * Extract the content between the first '(' and the matching last ')' of a
 * STEP call like  FILE_NAME(...);
 */
function extractInner(s: string): string | null {
  const start = s.indexOf('(');
  const end = s.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start + 1, end);
}

/**
 * Parse a STEP argument list into an array of raw token strings.
 *
 * Handles:
 *   - Quoted strings          'hello'
 *   - List literals           ('a','b')
 *   - Nested parens in lists  unlikely but tolerated
 */
function parseStepArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (ch === "'" && !inStr) {
      inStr = true;
      cur += ch;
      continue;
    }
    if (ch === "'" && inStr) {
      // Handle escaped quote ''
      if (inner[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      inStr = false;
      cur += ch;
      continue;
    }
    if (inStr) {
      cur += ch;
      continue;
    }

    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }

    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }

    cur += ch;
  }

  if (cur.trim()) args.push(cur.trim());
  return args;
}

/** The seven FILE_NAME arguments, in ISO 10303-21 order. */
export const FILE_NAME_FIELDS = [
  { key: 'name', label: 'Nom du fichier', cleared: true },
  { key: 'timestamp', label: 'Horodatage', cleared: false },
  { key: 'author', label: 'Auteur', cleared: true },
  { key: 'organization', label: 'Organisation', cleared: true },
  { key: 'preprocessor', label: 'Préprocesseur', cleared: false },
  { key: 'originatingSystem', label: "Système d'origine", cleared: false },
  { key: 'authorization', label: 'Autorisation', cleared: true },
] as const;

/**
 * Extract the raw FILE_NAME arguments of a STEP file, keyed by field name.
 *
 * Returns null when the file has no parsable FILE_NAME entry. Values are the
 * raw STEP tokens (quotes and list parentheses included), which is what the
 * comparison view wants to show.
 */
export function parseFileNameFields(text: string): Record<string, string> | null {
  const block = findFileNameBlock(text);
  if (!block) return null;

  const inner = extractInner(block.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim());
  if (!inner) return null;

  const args = parseStepArgs(inner);
  if (args.length < 7) return null;

  const out: Record<string, string> = {};
  FILE_NAME_FIELDS.forEach((f, i) => {
    out[f.key] = args[i] ?? '';
  });
  return out;
}

/** Return the full `FILE_NAME(...);` statement, spanning lines if needed. */
export function findFileNameBlock(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let block = '';
  let collecting = false;

  for (const line of lines) {
    if (!collecting && /^\s*FILE_NAME\s*\(/i.test(line)) {
      block = line;
      if (isClosed(block)) return block;
      collecting = true;
      continue;
    }
    if (collecting) {
      block += '\n' + line;
      if (isClosed(block)) return block;
    }
  }
  return null;
}

/**
 * Split a STEP file into its HEADER part (everything up to and including the
 * line that opens the DATA section) and the DATA part that carries geometry.
 *
 * The anonymizer must never touch the DATA part, so the comparison view checks
 * it byte for byte.
 */
export function splitHeaderData(text: string): { header: string; data: string } {
  const m = /^[ \t]*DATA[ \t]*;/im.exec(text);
  if (!m) return { header: text, data: '' };
  const cut = m.index + m[0].length;
  return { header: text.slice(0, cut), data: text.slice(cut) };
}
