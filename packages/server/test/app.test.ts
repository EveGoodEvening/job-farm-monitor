import { describe, expect, it } from 'vitest';
import { APP_VERSION, HOUR_MS, MINUTE_MS, Store, type Envelope, type StateResponse } from '@jfm/core';
import { nodeSqliteDriver } from '@jfm/core/drivers/node-sqlite';
import { INGEST_BODY_MAX_BYTES, LOGIN_BODY_MAX_BYTES, createApp, type Runtime } from '../src/app.js';
import { parseWriteTokens } from '../src/auth.js';
import { LocalBackend } from '../src/backend.js';
import { READ_TOKEN, WRITE_TOKEN_A, WRITE_TOKENS, defineApiSuite } from './api-suite.js';

function makeApp(over: Partial<Runtime> = {}) {
  const driver = nodeSqliteDriver(':memory:');
  const backend = new LocalBackend(new Store(driver));
  const app = createApp(() => ({
    backend,
    readToken: READ_TOKEN,
    writeTokens: parseWriteTokens(WRITE_TOKENS),
    version: APP_VERSION,
    driverName: driver.name,
    ...over,
  }));
  return { app, driver };
}

defineApiSuite('app.request() + node-sqlite :memory: (https)', async () => {
  const { app, driver } = makeApp();
  return {
    driver: 'node-sqlite',
    https: true,
    fetch: async (path, init) => app.request(`https://jfm.test${path}`, init),
    cleanup: async () => void (await driver.close?.()),
  };
});

defineApiSuite('app.request() + node-sqlite :memory: (http)', async () => {
  const { app, driver } = makeApp();
  return {
    driver: 'node-sqlite',
    https: false,
    fetch: async (path, init) => app.request(`http://localhost${path}`, init),
    cleanup: async () => void (await driver.close?.()),
  };
});

describe('createApp runtime options', () => {
  it('secureCookies forces the Secure flag on http', async () => {
    const { app } = makeApp({ secureCookies: true });
    const res = await app.request('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({ token: READ_TOKEN }),
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('X-Forwarded-Proto: https (TLS-terminating proxy) sets the Secure flag', async () => {
    const { app } = makeApp();
    const res = await app.request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ token: READ_TOKEN }),
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('empty READ_TOKEN: login, Bearer and cookies never succeed', async () => {
    const { app } = makeApp({ readToken: '' });
    const login = await app.request('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({ token: '' }),
    });
    expect(login.status).toBe(401);
    const me = await app.request('http://localhost/api/me', { headers: { authorization: 'Bearer ' } });
    expect(me.status).toBe(401);
  });

  it('empty WRITE_TOKENS: every ingest is 401', async () => {
    const { app } = makeApp({ writeTokens: parseWriteTokens('') });
    const res = await app.request('http://localhost/api/ingest', {
      method: 'POST',
      headers: { authorization: 'Bearer anything' },
      body: '[]',
    });
    expect(res.status).toBe(401);
  });

  it('a failing backend yields 500 JSON without leaking details', async () => {
    const boom = new Error('secret detail');
    const { app } = makeApp({
      backend: {
        ingest: () => Promise.reject(boom),
        state: () => Promise.reject(boom),
        session: () => Promise.reject(boom),
      },
    });
    const orig = console.error;
    console.error = () => undefined;
    try {
      const res = await app.request('http://localhost/api/state', {
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal' });
    } finally {
      console.error = orig;
    }
  });

  it('async runtime resolvers are supported', async () => {
    const backend = new LocalBackend(new Store(nodeSqliteDriver(':memory:')));
    const app = createApp(async () => ({
      backend,
      readToken: READ_TOKEN,
      writeTokens: new Map(),
      version: APP_VERSION,
      driverName: 'x',
    }));
    const res = await app.request('http://localhost/api/health');
    expect(await res.json()).toEqual({ ok: true, version: APP_VERSION, driver: 'x' });
  });
});

/** A body stream without Content-Length (chunked), `chunks` x `size` bytes of 'a'. */
function streamBody(prefix: string, chunks: number, size: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(ctl) {
      if (i === 0) ctl.enqueue(enc.encode(prefix));
      if (i >= chunks) return ctl.close();
      i += 1;
      ctl.enqueue(enc.encode('a'.repeat(size)));
    },
  });
}

describe('request body limits', () => {
  it(`POST /api/login: bodies over ${LOGIN_BODY_MAX_BYTES} bytes -> 413 before any parsing`, async () => {
    const { app } = makeApp();
    const big = JSON.stringify({ token: 'x'.repeat(LOGIN_BODY_MAX_BYTES) });
    const res = await app.request('http://localhost/api/login', { method: 'POST', body: big });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('POST /api/login: chunked bodies are cut off at the limit too', async () => {
    const { app } = makeApp();
    const req = new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'transfer-encoding': 'chunked' },
      body: streamBody('{"token":"', 1000, 1024),
      duplex: 'half',
    } as RequestInit);
    const res = await app.request(req);
    expect(res.status).toBe(413);
  });

  it('POST /api/login: a normal body still works', async () => {
    const { app } = makeApp();
    const res = await app.request('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({ token: READ_TOKEN }),
    });
    expect(res.status).toBe(204);
  });

  it('POST /api/ingest: 401 without a write token (body never read), 413 over the cap with one', async () => {
    const { app } = makeApp();
    const body = 'x'.repeat(INGEST_BODY_MAX_BYTES + 1);
    const anon = await app.request('http://localhost/api/ingest', { method: 'POST', body });
    expect(anon.status).toBe(401);
    const big = await app.request('http://localhost/api/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${WRITE_TOKEN_A}` },
      body,
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });
  });
});

describe('GET /api/state: ended sessions age out of the window without new events', () => {
  function setup() {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const driver = nodeSqliteDriver(':memory:');
    const backend = new LocalBackend(new Store(driver, { now: () => clock }));
    const app = createApp(() => ({
      backend,
      readToken: READ_TOKEN,
      writeTokens: parseWriteTokens(WRITE_TOKENS),
      version: APP_VERSION,
      driverName: driver.name,
    }));
    const env = (sessionId: string, event: string, ts: number, n: number): Envelope => ({
      v: 1,
      id: `${sessionId}-${n}`,
      ts,
      agent: 'claude',
      payload: { session_id: sessionId, cwd: '/p', hook_event_name: event },
    });
    return {
      app,
      env,
      now: () => clock,
      advance: (ms: number) => void (clock += ms),
      ingest: async (envs: Envelope[]) => {
        // Store clock drives received time too: ts == now keeps it in order.
        const res = await app.request('http://localhost/api/ingest', {
          method: 'POST',
          headers: { authorization: `Bearer ${WRITE_TOKEN_A}` },
          body: JSON.stringify(envs),
        });
        expect(res.status).toBe(200);
      },
      state: (q: string) =>
        app.request(`http://localhost/api/state${q}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } }),
    };
  }

  it('returns 200 without the session once it ended more than the window ago (1h and 24h)', async () => {
    const t = setup();
    await t.ingest([t.env('live', 'SessionStart', t.now(), 1), t.env('gone', 'SessionStart', t.now(), 2)]);
    t.advance(MINUTE_MS);
    await t.ingest([t.env('gone', 'SessionEnd', t.now(), 3)]);

    for (const [q, windowMs] of [['?ended=1h', HOUR_MS], ['?ended=24h', 24 * HOUR_MS]] as const) {
      const first = (await (await t.state(q)).json()) as StateResponse;
      expect(first.sessions.map((s) => s.sessionId).sort()).toEqual(['gone', 'live']);
      const since = `${q}&since=${first.revision}`;

      t.advance(windowMs / 2);
      expect((await t.state(since)).status).toBe(304);

      t.advance(windowMs / 2 + 1000);
      const aged = await t.state(since);
      expect(aged.status).toBe(200);
      const body = (await aged.json()) as StateResponse;
      expect(body.revision).toBe(first.revision);
      expect(body.sessions.map((s) => s.sessionId)).toEqual(['live']);
      // Rewind for the 24h pass: the session is in the window again.
      t.advance(-(windowMs + 1000));
    }
  });

  it('keeps answering 304 when the aged-out session was already gone from the snapshot', async () => {
    const t = setup();
    await t.ingest([t.env('old', 'SessionStart', t.now(), 1)]);
    await t.ingest([t.env('old', 'SessionEnd', t.now(), 2)]);
    t.advance(2 * HOUR_MS);
    await t.ingest([t.env('live', 'SessionStart', t.now(), 3)]);
    const first = (await (await t.state('')).json()) as StateResponse;
    expect(first.sessions.map((s) => s.sessionId)).toEqual(['live']);
    t.advance(10 * MINUTE_MS);
    expect((await t.state(`?since=${first.revision}`)).status).toBe(304);
  });
});
