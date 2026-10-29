import { describe, expect, it } from 'vitest';
import {
  AGENT_KINDS,
  CANONICAL_EVENT_TYPES,
  ENDED_WINDOWS,
  INGEST_MAX_BATCH,
  PROGRESS_CARD,
  PROGRESS_KEEP,
  parseSessionKey,
  sessionKey,
} from '../src/index.js';

describe('shared contracts', () => {
  it('locks key constants', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex', 'omp']);
    expect(CANONICAL_EVENT_TYPES).toHaveLength(14);
    expect(PROGRESS_KEEP).toBe(10);
    expect(PROGRESS_CARD).toBe(4);
    expect(INGEST_MAX_BATCH).toBe(100);
    expect(ENDED_WINDOWS['1h']).toBe(3_600_000);
    expect(ENDED_WINDOWS['24h']).toBe(86_400_000);
  });

  it('round-trips session keys, including slashes in the session id', () => {
    const key = sessionKey('kvm16188', 'claude', 'abc/def');
    expect(key).toBe('kvm16188/claude/abc/def');
    expect(parseSessionKey(key)).toEqual({ host: 'kvm16188', agent: 'claude', sessionId: 'abc/def' });
    expect(parseSessionKey('nohost')).toBeNull();
    expect(parseSessionKey('h//x')).toBeNull();
    expect(parseSessionKey('h/a/')).toBeNull();
  });
});
