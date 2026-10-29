// Internal string helpers (not part of the public contract).

const ELLIPSIS = '…';

/** Collapse all whitespace runs (incl. newlines) to single spaces and trim. */
export function oneLine(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

/**
 * Truncate to at most `max` code points (never splits a surrogate pair). When
 * cut, the last kept character is replaced by "…" so the result is <= max.
 */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s; // fast path: UTF-16 length >= code point count
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  if (max <= 0) return '';
  return cps.slice(0, max - 1).join('') + ELLIPSIS;
}

/** clip(oneLine(s), max) */
export function clipLine(s: string, max: number): string {
  return clip(oneLine(s), max);
}

/** First non-blank line, trimmed ('' if none). */
export function firstLine(s: string): string {
  for (const line of s.split(/\r?\n/u)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** Last path segment, ignoring trailing separators; null for empty/root. */
export function basename(path: string): string | null {
  const trimmed = path.replace(/[/\\]+$/u, '');
  if (!trimmed) return null;
  const parts = trimmed.split(/[/\\]/u);
  return parts[parts.length - 1] || null;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** v if it is a non-empty string, else undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
