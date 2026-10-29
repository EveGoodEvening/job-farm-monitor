import type { StateResponse } from '@jfm/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyStateResult,
  bootAuth,
  bootBackoffMs,
  fetchSession,
  fetchState,
  login,
  me,
  stateUrl,
  tokenFromHash,
} from '../src/api.ts';
import { authed, conn, revision, serverOffsetMs, sessions } from '../src/state.ts';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body?: unknown) {
  const f = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body === undefined ? null : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', f);
  return f;
}

describe('url helpers', () => {
  it('stateUrl', () => {
    expect(stateUrl(null, '1h')).toBe('/api/state?ended=1h');
    expect(stateUrl(42, '24h')).toBe('/api/state?since=42&ended=24h');
    expect(stateUrl(0, '1h')).toBe('/api/state?since=0&ended=1h');
  });
  it('tokenFromHash', () => {
    expect(tokenFromHash('#token=abc123')).toBe('abc123');
    expect(tokenFromHash('#x=1&token=a%2Bb')).toBe('a+b');
    expect(tokenFromHash('#token=')).toBeNull();
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#mytoken=abc')).toBeNull();
  });
});

describe('fetch wrappers', () => {
  it('fetchState maps 200/304/401/500/network', async () => {
    const snap: StateResponse = { revision: 3, now: 1, sessions: [] };
    stubFetch(200, snap);
    expect(await fetchState(null)).toEqual({ kind: 'ok', data: snap });
    stubFetch(304);
    expect(await fetchState(3)).toEqual({ kind: 'unchanged' });
    stubFetch(401, { error: 'unauthorized' });
    expect(await fetchState(3)).toEqual({ kind: 'unauthorized' });
    stubFetch(500, { error: 'x' });
    expect(await fetchState(3)).toEqual({ kind: 'error', status: 500 });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    expect(await fetchState(3)).toEqual({ kind: 'error', status: 0 });
  });

  it('fetchSession encodes the key once', async () => {
    const f = stubFetch(404, { error: 'not_found' });
    expect(await fetchSession('kvm/claude/abc')).toEqual({ kind: 'not_found' });
    expect(f.mock.calls[0]?.[0]).toBe('/api/sessions/kvm%2Fclaude%2Fabc');
  });

  it('login / me', async () => {
    const f = stubFetch(204);
    expect(await login('tok')).toBe('ok');
    const init = f.mock.calls[0]?.[1] ?? {};
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'tok' });
    stubFetch(401, { error: 'unauthorized' });
    expect(await login('bad')).toBe('wrong');
    expect(await me()).toBe(false);
    stubFetch(204);
    expect(await me()).toBe(true);
  });
});

describe('applyStateResult', () => {
  it('ok stores snapshot, revision and clock offset; 304 keeps data; 401 logs out', () => {
    authed.value = true;
    applyStateResult({ kind: 'ok', data: { revision: 7, now: 10_500, sessions: [] } }, 10_000);
    expect(revision.value).toBe(7);
    expect(serverOffsetMs.value).toBe(500);
    expect(sessions.value).toEqual([]);
    expect(conn.value).toBe('live');
    applyStateResult({ kind: 'error', status: 502 });
    expect(conn.value).toBe('error');
    expect(revision.value).toBe(7);
    applyStateResult({ kind: 'unchanged' });
    expect(conn.value).toBe('live');
    applyStateResult({ kind: 'unauthorized' });
    expect(authed.value).toBe(false);
  });
});

describe('bootAuth', () => {
  function seqFetch(statuses: (number | 'net')[]) {
    const f = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const st = statuses.shift() ?? 500;
      if (st === 'net') throw new TypeError('offline');
      return new Response(null, { status: st });
    });
    vi.stubGlobal('fetch', f);
    return f;
  }

  it('a transient /api/me failure keeps authed unknown and retries; it does not show the login page', async () => {
    authed.value = null;
    conn.value = 'connecting';
    const f = seqFetch(['net', 503, 204]);
    const sleeps: number[] = [];
    const seen: (boolean | null)[] = [];
    const ok = await bootAuth(null, async (ms) => {
      sleeps.push(ms);
      seen.push(authed.value);
      expect(conn.value).toBe('error');
    });
    expect(ok).toBe(true);
    expect(authed.value).toBe(true);
    expect(seen).toEqual([null, null]); // never false while retrying
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(f).toHaveBeenCalledTimes(3);
    expect(conn.value).toBe('connecting');
  });

  it('only a definite 401 shows the login page', async () => {
    authed.value = null;
    seqFetch([502, 401]);
    expect(await bootAuth(null, async () => {})).toBe(false);
    expect(authed.value).toBe(false);
  });

  it('#token= login is retried on network errors, then /api/me decides', async () => {
    authed.value = null;
    const f = seqFetch(['net', 204, 204]);
    expect(await bootAuth('tok', async () => {})).toBe(true);
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/login', '/api/login', '/api/me']);
  });

  it('backoff doubles and caps at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(bootBackoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });
});
