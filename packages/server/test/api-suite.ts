// Shared HTTP API suite (docs/contracts.md section 4). Platform-neutral: runs
// against app.request() (app.test.ts), a real @hono/node-server listener on the
// Vercel entry (vercel-entry.test.ts) and the Worker inside workerd
// (worker.test.ts). No node:* imports here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COOKIE_MAX_AGE_S,
  COOKIE_NAME,
  HOUR_MS,
  INGEST_MAX_BATCH,
  LOGIN_FAIL_DELAY_MS,
  PROGRESS_CARD,
  PROGRESS_KEEP,
  type Envelope,
  type IngestResult,
  type SessionView,
  type StateResponse,
} from '@jfm/core';

import { READ_TOKEN, WRITE_TOKEN_A, WRITE_TOKEN_B } from './tokens.js';

export { READ_TOKEN, WRITE_TOKEN_A, WRITE_TOKEN_B, WRITE_TOKENS } from './tokens.js';

export type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ApiTarget {
  fetch: Fetch;
  /** Driver name expected in /api/health. */
  driver: string;
  /** Whether requests are made over https (cookie Secure flag expected). */
  https: boolean;
  cleanup?(): Promise<void>;
}

let seq = 0;
const runId = Math.random().toString(36).slice(2, 8);

/** Unique session id per call so suites never depend on shared DB state. */
export function sid(label: string): string {
  seq += 1;
  return `${label}-${runId}-${seq}`;
}

export function claude(
  sessionId: string,
  payload: Record<string, unknown>,
  over: Partial<Envelope> = {},
): Envelope {
  seq += 1;
  return {
    v: 1,
    id: `ev-${runId}-${seq}`,
    ts: Date.now(),
    agent: 'claude',
    hostname: 'reported-hostname',
    payload: { session_id: sessionId, cwd: '/home/u/proj-x', ...payload },
    ...over,
  };
}

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

export function defineApiSuite(name: string, make: () => Promise<ApiTarget>): void {
  describe(`HTTP API: ${name}`, () => {
    let t: ApiTarget;
    const f: Fetch = (path, init) => t.fetch(path, init);

    const ingest = async (body: unknown, token = WRITE_TOKEN_A) => {
      const res = await f('/api/ingest', json(body, token));
      expect(res.status).toBe(200);
      return (await res.json()) as IngestResult;
    };
    const state = async (query = '') => {
      const res = await f(`/api/state${query}`, bearer(READ_TOKEN));
      expect(res.status).toBe(200);
      return (await res.json()) as StateResponse;
    };
    const find = (s: StateResponse, sessionId: string) =>
      s.sessions.find((x) => x.sessionId === sessionId);

    beforeAll(async () => {
      t = await make();
    });
    afterAll(async () => {
      await t?.cleanup?.();
    });

    it('GET /api/health is public and reports version + driver', async () => {
      const res = await f('/api/health');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ ok: true, version: '0.1.0', driver: t.driver });
    });

    it('unknown /api/* routes return 404 JSON', async () => {
      for (const [path, method] of [
        ['/api/nope', 'GET'],
        ['/api/state/extra', 'GET'],
        ['/api', 'GET'],
        ['/api/health', 'DELETE'],
      ] as const) {
        const res = await f(path, { method, ...bearer(READ_TOKEN) });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.json()).toEqual({ error: 'not_found' });
      }
    });

    describe('read auth', () => {
      it('GET /api/me: 401 without credentials, 204 with Bearer READ_TOKEN', async () => {
        const anon = await f('/api/me');
        expect(anon.status).toBe(401);
        expect(await anon.json()).toEqual({ error: 'unauthorized' });
        expect((await f('/api/me', bearer('wrong'))).status).toBe(401);
        expect((await f('/api/me', bearer(WRITE_TOKEN_A))).status).toBe(401);
        expect((await f('/api/me', bearer(READ_TOKEN))).status).toBe(204);
      });

      it('protects /api/state and /api/sessions/:key', async () => {
        expect((await f('/api/state')).status).toBe(401);
        expect((await f('/api/state', bearer('nope'))).status).toBe(401);
        expect((await f(`/api/sessions/${encodeURIComponent('hostA/claude/x')}`)).status).toBe(401);
      });

      it('POST /api/login rejects malformed bodies with 400', async () => {
        for (const body of ['not json', '[]', '{}', '{"token":42}', 'null']) {
          const res = await f('/api/login', json(body));
          expect(res.status, body).toBe(400);
          expect(await res.json()).toEqual({ error: 'bad_request' });
        }
      });

      it('POST /api/login: wrong token -> 401 after the delay, no cookie', async () => {
        const started = Date.now();
        const res = await f('/api/login', json({ token: 'wrong' }));
        expect(res.status).toBe(401);
        expect(Date.now() - started).toBeGreaterThanOrEqual(LOGIN_FAIL_DELAY_MS - 20);
        expect(res.headers.get('set-cookie')).toBeNull();
      });

      it('POST /api/login sets the signed cookie, which authorizes reads', async () => {
        const res = await f('/api/login', json({ token: READ_TOKEN }));
        expect(res.status).toBe(204);
        const setCookie = res.headers.get('set-cookie') ?? '';
        expect(setCookie).toMatch(new RegExp(`^${COOKIE_NAME}=\\d+\\.[A-Za-z0-9_-]+;`));
        expect(setCookie).toContain(`Max-Age=${COOKIE_MAX_AGE_S}`);
        expect(setCookie).toContain('Path=/');
        expect(setCookie).toContain('HttpOnly');
        expect(setCookie).toContain('SameSite=Lax');
        expect(setCookie.includes('Secure')).toBe(t.https);

        const cookie = setCookie.split(';')[0] ?? '';
        const exp = Number(cookie.slice(COOKIE_NAME.length + 1).split('.')[0]);
        expect(exp).toBeGreaterThan(Date.now() + COOKIE_MAX_AGE_S * 1000 - 60_000);

        expect((await f('/api/me', { headers: { cookie } })).status).toBe(204);
        expect((await f('/api/state', { headers: { cookie } })).status).toBe(200);

        // Tampered signature / expiry.
        const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
        expect((await f('/api/me', { headers: { cookie: tampered } })).status).toBe(401);
        const [, sig] = cookie.split('.');
        const otherExp = `${COOKIE_NAME}=${exp + 1}.${sig}`;
        expect((await f('/api/me', { headers: { cookie: otherExp } })).status).toBe(401);
      });

      it('POST /api/logout clears the cookie', async () => {
        const res = await f('/api/logout', { method: 'POST' });
        expect(res.status).toBe(204);
        const setCookie = res.headers.get('set-cookie') ?? '';
        expect(setCookie).toMatch(new RegExp(`^${COOKIE_NAME}=;`));
        expect(setCookie).toContain('Max-Age=0');
        expect(setCookie).toContain('Path=/');
        expect(setCookie).toContain('HttpOnly');
      });
    });

    describe('POST /api/ingest', () => {
      it('requires a write token (401), never the read token', async () => {
        const body = [claude(sid('auth'), { hook_event_name: 'SessionStart' })];
        for (const init of [
          json(body),
          json(body, 'wrong'),
          json(body, READ_TOKEN),
          { ...json(body), headers: { 'content-type': 'application/json', authorization: WRITE_TOKEN_A } },
        ]) {
          const res = await f('/api/ingest', init);
          expect(res.status).toBe(401);
          expect(await res.json()).toEqual({ error: 'unauthorized' });
        }
      });

      it('invalid JSON -> 400', async () => {
        const res = await f('/api/ingest', json('{"v":1,', WRITE_TOKEN_A));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'bad_request' });
      });

      it(`more than ${INGEST_MAX_BATCH} envelopes -> 413`, async () => {
        const id = sid('big');
        const body = Array.from({ length: INGEST_MAX_BATCH + 1 }, () =>
          claude(id, { hook_event_name: 'SessionStart' }),
        );
        const res = await f('/api/ingest', json(body, WRITE_TOKEN_A));
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: 'too_large' });
        const s = await state();
        expect(find(s, id)).toBeUndefined();
      });

      it('[] is valid and returns the current revision', async () => {
        const a = await ingest([]);
        expect(a.accepted).toBe(0);
        expect(a.ignored).toBe(0);
        const s = await state();
        expect(a.revision).toBe(s.revision);
      });

      it('accepts one envelope or an array; bad items and duplicates are ignored', async () => {
        const id = sid('mix');
        const start = claude(id, { hook_event_name: 'SessionStart', source: 'startup' });
        const single = await ingest(start);
        expect(single).toMatchObject({ accepted: 1, ignored: 0 });

        const prompt = claude(id, { hook_event_name: 'UserPromptSubmit', prompt: 'fix the tests\nmore' });
        const batch = await ingest([prompt, { v: 2, id: 'bad' }, 'garbage', start]);
        expect(batch.accepted).toBe(1);
        expect(batch.ignored).toBe(3); // 2 invalid + 1 duplicate id
        expect(batch.revision).toBeGreaterThan(single.revision);

        const dup = await ingest([prompt]);
        expect(dup).toEqual({ accepted: 0, ignored: 1, revision: batch.revision });
      });

      it('host label comes from the write token, not the envelope hostname', async () => {
        const id = sid('host');
        await ingest([claude(id, { hook_event_name: 'SessionStart' }, { hostname: 'hostA' })], WRITE_TOKEN_B);
        const s = find(await state(), id);
        expect(s?.host).toBe('hostB');
        expect(s?.hostname).toBe('hostA');
        expect(s?.key).toBe(`hostB/claude/${id}`);
      });
    });

    describe('GET /api/state', () => {
      it('returns a snapshot, 304 when unchanged, 200 again after a change', async () => {
        const id = sid('state');
        await ingest([
          claude(id, { hook_event_name: 'SessionStart' }),
          claude(id, { hook_event_name: 'UserPromptSubmit', prompt: 'run the suite' }),
          claude(id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
        ]);
        const s = await state();
        expect(s.now).toBeGreaterThan(0);
        const view = find(s, id);
        expect(view).toMatchObject({
          host: 'hostA',
          agent: 'claude',
          state: 'working',
          title: 'run the suite',
          project: 'proj-x',
        });
        expect(view?.progress[0]?.text).toContain('npm test');
        const sorted = [...s.sessions].sort((a, b) => b.lastEventAt - a.lastEventAt);
        expect(s.sessions.map((x) => x.key)).toEqual(sorted.map((x) => x.key));

        const same = await f(`/api/state?since=${s.revision}`, bearer(READ_TOKEN));
        expect(same.status).toBe(304);
        expect(same.headers.get('cache-control')).toBe('no-store');
        expect(await same.text()).toBe('');

        const old = await f(`/api/state?since=${s.revision - 1}`, bearer(READ_TOKEN));
        expect(old.status).toBe(200);
        expect(((await old.json()) as StateResponse).revision).toBe(s.revision);

        // Invalid since -> full snapshot.
        for (const q of ['?since=abc', '?since=-1', '?since=']) {
          expect((await f(`/api/state${q}`, bearer(READ_TOKEN))).status, q).toBe(200);
        }

        await ingest([claude(id, { hook_event_name: 'Stop', last_assistant_message: 'All green.' })]);
        const next = await f(`/api/state?since=${s.revision}`, bearer(READ_TOKEN));
        expect(next.status).toBe(200);
        const body = (await next.json()) as StateResponse;
        expect(body.revision).toBeGreaterThan(s.revision);
        expect(find(body, id)).toMatchObject({ state: 'done', lastMessage: 'All green.' });
      });

      it(`limits progress to ${PROGRESS_CARD} lines per session`, async () => {
        const id = sid('prog');
        const t0 = Date.now() - 60_000;
        await ingest(
          Array.from({ length: 12 }, (_, i) =>
            claude(
              id,
              { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${i}` } },
              { ts: t0 + i * 1000 },
            ),
          ),
        );
        const view = find(await state(), id);
        expect(view?.progress).toHaveLength(PROGRESS_CARD);
        expect(view?.progress[0]?.text).toContain('echo 11');
      });

      it('ended=1h|24h controls which ended sessions are returned', async () => {
        const recent = sid('ended-recent');
        const old = sid('ended-old');
        const now = Date.now();
        await ingest([
          claude(recent, { hook_event_name: 'SessionStart' }, { ts: now - 10_000 }),
          claude(recent, { hook_event_name: 'SessionEnd', reason: 'exit' }, { ts: now - 5_000 }),
          claude(old, { hook_event_name: 'SessionStart' }, { ts: now - 3 * HOUR_MS }),
          claude(old, { hook_event_name: 'SessionEnd', reason: 'exit' }, { ts: now - 2 * HOUR_MS }),
        ]);
        for (const q of ['', '?ended=1h', '?ended=bogus']) {
          const s = await state(q);
          expect(find(s, recent)?.state, q).toBe('ended');
          expect(find(s, old), q).toBeUndefined();
        }
        const day = await state('?ended=24h');
        expect(find(day, recent)?.state).toBe('ended');
        expect(find(day, old)?.state).toBe('ended');
      });
    });

    describe('GET /api/sessions/:key', () => {
      it(`returns the full view with up to ${PROGRESS_KEEP} progress lines`, async () => {
        const id = `${sid('detail')}/with/slash%and%25percent`;
        const t0 = Date.now() - 60_000;
        await ingest([
          claude(id, { hook_event_name: 'SessionStart' }, { ts: t0 }),
          ...Array.from({ length: 12 }, (_, i) =>
            claude(
              id,
              { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `step ${i}` } },
              { ts: t0 + (i + 1) * 1000 },
            ),
          ),
        ]);
        const key = `hostA/claude/${id}`;
        const res = await f(`/api/sessions/${encodeURIComponent(key)}`, bearer(READ_TOKEN));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const view = (await res.json()) as SessionView;
        expect(view.key).toBe(key);
        expect(view.sessionId).toBe(id);
        expect(view.progress).toHaveLength(PROGRESS_KEEP);
        expect(view.progress[0]?.text).toContain('step 11');
      });

      it('unknown key -> 404', async () => {
        const res = await f(`/api/sessions/${encodeURIComponent('hostA/claude/missing')}`, bearer(READ_TOKEN));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'not_found' });
      });
    });
  });
}
