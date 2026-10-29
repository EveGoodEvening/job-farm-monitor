// Thin client for the job-farm-monitor HTTP API (docs/contracts.md section 4) plus
// the 3-second poller. Same-origin only: the cookie `jfm_s` carries read auth.
import { POLL_INTERVAL_MS } from '@jfm/core';
import type { EndedWindow, SessionView, StateResponse } from '@jfm/core';
import { batch } from '@preact/signals';
import { authed, conn, lastOkAt, revision, serverOffsetMs, sessions, showEnded } from './state.ts';

export type FetchResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unchanged' }
  | { kind: 'unauthorized' }
  | { kind: 'not_found' }
  | { kind: 'error'; status: number };

const JSON_HEADERS = { 'content-type': 'application/json' };

async function request(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...init });
  } catch {
    return null; // network failure
  }
}

function statusResult(res: Response | null): FetchResult<never> {
  if (!res) return { kind: 'error', status: 0 };
  if (res.status === 304) return { kind: 'unchanged' };
  if (res.status === 401) return { kind: 'unauthorized' };
  if (res.status === 404) return { kind: 'not_found' };
  return { kind: 'error', status: res.status };
}

/** POST /api/login. 'ok' sets the HttpOnly cookie. */
export async function login(token: string): Promise<'ok' | 'wrong' | 'network'> {
  const res = await request('/api/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token }) });
  if (!res) return 'network';
  if (res.status === 204 || res.ok) return 'ok';
  return res.status === 401 || res.status === 400 ? 'wrong' : 'network';
}

export async function logout(): Promise<void> {
  await request('/api/logout', { method: 'POST' });
}

/** GET /api/me: true (204), false (401), null (network / other error). */
export async function me(): Promise<boolean | null> {
  const res = await request('/api/me');
  if (!res) return null;
  if (res.status === 204 || res.ok) return true;
  if (res.status === 401) return false;
  return null;
}

/** Backoff for boot-time auth retries: 1 s, 2 s, 4 s ... capped at 30 s. */
export function bootBackoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Boot-time auth: optional `#token=` login, then /api/me. A transient failure
 * (network, 5xx: cold start, function timeout, flaky mobile data) is NOT a
 * logout: `authed` stays null (boot screen), `conn` shows the error, and both
 * calls are retried with backoff until the server gives a definite answer.
 * Only a definite 401 shows the login page. Resolves with the final verdict.
 */
export async function bootAuth(token: string | null, sleep: (ms: number) => Promise<void> = wait): Promise<boolean> {
  let attempt = 0;
  if (token !== null) {
    for (;;) {
      const r = await login(token);
      if (r !== 'network') break; // 'wrong' falls through to /api/me (an older cookie may still be valid)
      conn.value = 'error';
      await sleep(bootBackoffMs(attempt++));
    }
  }
  for (;;) {
    const ok = await me();
    if (ok !== null) {
      batch(() => {
        if (conn.value === 'error') conn.value = 'connecting';
        authed.value = ok;
      });
      return ok;
    }
    conn.value = 'error';
    await sleep(bootBackoffMs(attempt++));
  }
}

export function stateUrl(since: number | null, ended: EndedWindow): string {
  const q = new URLSearchParams();
  if (since !== null) q.set('since', String(since));
  q.set('ended', ended);
  return `/api/state?${q.toString()}`;
}

/** GET /api/state: 200 snapshot, 304 unchanged, 401. */
export async function fetchState(since: number | null, ended: EndedWindow = '1h'): Promise<FetchResult<StateResponse>> {
  const res = await request(stateUrl(since, ended));
  if (res?.status === 200) {
    try {
      return { kind: 'ok', data: (await res.json()) as StateResponse };
    } catch {
      return { kind: 'error', status: 200 };
    }
  }
  return statusResult(res);
}

/** GET /api/sessions/:key (key is percent-encoded once; it contains "/"). */
export async function fetchSession(key: string): Promise<FetchResult<SessionView>> {
  const res = await request(`/api/sessions/${encodeURIComponent(key)}`);
  if (res?.status === 200) {
    try {
      return { kind: 'ok', data: (await res.json()) as SessionView };
    } catch {
      return { kind: 'error', status: 200 };
    }
  }
  return statusResult(res);
}

// ---------------------------------------------------------------------------
// Poller: one request in flight, POLL_INTERVAL_MS between the end of a request
// and the next one, stopped while the tab is hidden, stopped on 401.
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let inflight = false;
let again = false;
/** Bumped by refreshFull(); a response from an older generation is discarded. */
let generation = 0;

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function schedule(): void {
  clearTimeout(timer);
  timer = undefined;
  if (running && visible()) timer = setTimeout(() => void pollNow(), POLL_INTERVAL_MS);
}

/** Apply one poll result to the signals. Exported for tests. */
export function applyStateResult(r: FetchResult<StateResponse>, clientNow = Date.now()): void {
  batch(() => {
    switch (r.kind) {
      case 'ok':
        sessions.value = r.data.sessions;
        revision.value = r.data.revision;
        serverOffsetMs.value = r.data.now - clientNow;
        lastOkAt.value = clientNow;
        conn.value = 'live';
        break;
      case 'unchanged':
        lastOkAt.value = clientNow;
        conn.value = 'live';
        break;
      case 'unauthorized':
        authed.value = false;
        stopPolling();
        break;
      default:
        conn.value = 'error';
    }
  });
}

/** Poll immediately (coalesces with an in-flight request). */
export async function pollNow(): Promise<void> {
  if (!running) return;
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  clearTimeout(timer);
  const gen = generation;
  try {
    const r = await fetchState(revision.value, showEnded.value ? '24h' : '1h');
    if (running && gen === generation) applyStateResult(r);
  } finally {
    inflight = false;
  }
  if (again) {
    again = false;
    void pollNow();
  } else {
    schedule();
  }
}

/** Drop the cached revision and fetch a full snapshot (e.g. ended window changed). */
export function refreshFull(): void {
  generation++;
  revision.value = null;
  void pollNow();
}

function onVisibility(): void {
  if (!running) return;
  if (visible()) {
    conn.value = conn.value === 'paused' ? 'connecting' : conn.value;
    void pollNow();
  } else {
    clearTimeout(timer);
    timer = undefined;
    conn.value = 'paused';
  }
}

export function startPolling(): void {
  if (running) return;
  running = true;
  conn.value = 'connecting';
  document.addEventListener('visibilitychange', onVisibility);
  if (visible()) void pollNow();
  else conn.value = 'paused';
}

export function stopPolling(): void {
  running = false;
  clearTimeout(timer);
  timer = undefined;
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
}

/** `#token=<READ_TOKEN>` in the URL fragment, or null. */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)token=([^&]+)/.exec(hash);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
