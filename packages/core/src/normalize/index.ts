import type { CanonicalEvent, Envelope } from '../types.js';
import { normalizeClaude } from './claude.js';
import { normalizeCodex } from './codex.js';
import { normalizeOmp } from './omp.js';

export { normalizeClaude } from './claude.js';
export { normalizeCodex } from './codex.js';
export { normalizeOmp } from './omp.js';

/** Map one envelope to 0..n canonical events. Never throws; unknown -> []. */
export function normalize(envelope: Envelope): CanonicalEvent[] {
  try {
    switch (envelope.agent) {
      case 'claude':
        return normalizeClaude(envelope.payload);
      case 'codex':
        return normalizeCodex(envelope.payload);
      case 'omp':
        return normalizeOmp(envelope.payload);
      default:
        return [];
    }
  } catch {
    return [];
  }
}
