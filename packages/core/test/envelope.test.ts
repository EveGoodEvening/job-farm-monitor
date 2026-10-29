import { describe, expect, it } from 'vitest';
import { INGEST_MAX_BATCH, TooManyEnvelopesError, parseEnvelopes } from '../src/index.js';

const valid = {
  v: 1,
  id: 'abc-1',
  ts: 1761721234567,
  agent: 'claude',
  hostname: 'kvm16188',
  pid: 12345,
  env: { herdr_pane_id: 'wS:p1', herdr_tab_id: '', tmux_pane: '%3', bogus: 'x' },
  payload: { hook_event_name: 'Stop', session_id: 's1' },
  extra: 'ignored',
};

describe('parseEnvelopes', () => {
  it('accepts a single valid envelope and normalizes env / unknown keys', () => {
    const r = parseEnvelopes(valid);
    expect(r.ignored).toBe(0);
    expect(r.envelopes).toEqual([
      {
        v: 1,
        id: 'abc-1',
        ts: 1761721234567,
        agent: 'claude',
        hostname: 'kvm16188',
        pid: 12345,
        env: { herdr_pane_id: 'wS:p1', tmux_pane: '%3' },
        payload: { hook_event_name: 'Stop', session_id: 's1' },
      },
    ]);
  });

  it('accepts minimal envelopes for every agent', () => {
    const items = (['claude', 'codex', 'omp'] as const).map((agent, i) => ({
      v: 1,
      id: `id${i}`,
      ts: 0,
      agent,
      payload: {},
    }));
    const r = parseEnvelopes(items);
    expect(r).toMatchObject({ ignored: 0 });
    expect(r.envelopes.map((e) => e.agent)).toEqual(['claude', 'codex', 'omp']);
    expect(r.envelopes[0]).not.toHaveProperty('env');
  });

  it('counts invalid items (missing / wrong fields) as ignored without failing', () => {
    const { v: _v, ...noV } = valid;
    const { id: _id, ...noId } = valid;
    const { payload: _p, ...noPayload } = valid;
    const bad = [
      noV,
      noId,
      noPayload,
      { ...valid, v: 2 },
      { ...valid, id: '' },
      { ...valid, ts: 1.5 },
      { ...valid, ts: '1761721234567' },
      { ...valid, agent: 'gemini' },
      { ...valid, payload: 'str' },
      { ...valid, payload: null },
      { ...valid, payload: [] },
      null,
      42,
    ];
    const r = parseEnvelopes([...bad, valid]);
    expect(r.ignored).toBe(bad.length);
    expect(r.envelopes).toHaveLength(1);
  });

  it('treats a non-object, non-array body as one ignored item', () => {
    expect(parseEnvelopes('nope')).toEqual({ envelopes: [], ignored: 1 });
    expect(parseEnvelopes(null)).toEqual({ envelopes: [], ignored: 1 });
  });

  it('accepts an empty array (jfm-emit --check)', () => {
    expect(parseEnvelopes([])).toEqual({ envelopes: [], ignored: 0 });
  });

  it(`accepts exactly ${INGEST_MAX_BATCH} and throws above it`, () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ ...valid, id: `id-${i}` }));
    expect(parseEnvelopes(mk(INGEST_MAX_BATCH)).envelopes).toHaveLength(INGEST_MAX_BATCH);
    expect(() => parseEnvelopes(mk(INGEST_MAX_BATCH + 1))).toThrow(TooManyEnvelopesError);
    try {
      parseEnvelopes(mk(INGEST_MAX_BATCH + 1));
    } catch (e) {
      expect((e as TooManyEnvelopesError).count).toBe(INGEST_MAX_BATCH + 1);
    }
  });
});
