// Hono app shared by all three platforms. Routes: docs/contracts.md section 4.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  COOKIE_MAX_AGE_S,
  COOKIE_NAME,
  ENDED_VISIBLE_DEFAULT_MS,
  ENDED_WINDOWS,
  INGEST_MAX_BATCH,
  LOGIN_FAIL_DELAY_MS,
  PROGRESS_CARD,
  TooManyEnvelopesError,
  parseEnvelopes,
  type IngestResult,
  type StateBackend,
  type StateResponse,
} from '@jfm/core';
import { constantTimeEqual, findWriteHost, isReadAuthed, makeReadCookie } from './auth.js';

/** Per-request runtime resolved by each platform entry. */
export interface Runtime {
  backend: StateBackend;
  /** READ_TOKEN; empty string disables read auth success entirely. */
  readToken: string;
  /** From parseWriteTokens(WRITE_TOKENS): token -> host label. */
  writeTokens: Map<string, string>;
  /** APP_VERSION. */
  version: string;
  /** SqlDriver.name: "do-sqlite" | "node-sqlite" | "libsql". */
  driverName: string;
  /** Force the cookie Secure flag; default: request URL is https. */
  secureCookies?: boolean;
}

export type RuntimeResolver = (c: Context) => Runtime | Promise<Runtime>;

export type AppEnv = { Variables: { rt: Runtime; host: string } };

type ErrorCode = 'unauthorized' | 'bad_request' | 'not_found' | 'too_large' | 'internal';

const err = (c: Context, code: ErrorCode, status: 400 | 401 | 404 | 413 | 500) =>
  c.json({ error: code }, status);

/**
 * Request body caps, checked before the body is read (Content-Length) or while
 * it streams (chunked). /api/login is unauthenticated, so its cap is tiny; the
 * ingest cap sits above jfm-emit's 1 MB batches and below Vercel's 4.5 MB.
 */
export const LOGIN_BODY_MAX_BYTES = 4 * 1024;
export const INGEST_BODY_MAX_BYTES = 4 * 1024 * 1024;

const limitBody = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => err(c, 'too_large', 413) });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * https request URL, or `X-Forwarded-Proto: https` from a TLS-terminating proxy
 * (Railway, Vercel). Only decides the cookie Secure flag, so a spoofed header
 * can at worst break that client's own cookie over plain http.
 */
const isHttps = (c: Context) =>
  new URL(c.req.url).protocol === 'https:' ||
  c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https';

function parseSince(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return undefined;
  return Number(raw);
}

function parseEnded(raw: string | undefined): number {
  return raw !== undefined && Object.hasOwn(ENDED_WINDOWS, raw)
    ? ENDED_WINDOWS[raw as keyof typeof ENDED_WINDOWS]
    : ENDED_VISIBLE_DEFAULT_MS;
}

/**
 * GET /api/state. `backend.state` answers `null` (304) whenever `since` equals
 * the revision, but the ended window (`ended_at > now - window`) moves with
 * the clock: on a quiet farm the client's snapshot would keep ended sessions
 * past the window forever. So before a 304, check whether an ended session
 * may have aged out of the window since the client fetched revision `since`.
 *
 * The client fetched at some t_fetch >= L, where L is the newest
 * lastEventAt/endedAt (those are min(event ts, received time), and every such
 * write bumped the revision to at most `since`). Its snapshot therefore holds
 * no ended session with endedAt <= L - window, and is stale iff some ended
 * session has endedAt in (L - window, now - window]. Stateless and never a
 * wrong 304; the cost is a 200 instead of a 304 after such a crossing until
 * the revision next changes.
 */
async function stateFor(
  backend: StateBackend,
  since: number | undefined,
  windowMs: number,
  progressLimit: number,
): Promise<StateResponse | null> {
  const full = () => backend.state({ endedWithinMs: windowMs, progressLimit });
  const res = await backend.state({ since, endedWithinMs: windowMs, progressLimit });
  if (res !== null || since === undefined) return res;
  // Every row the store still holds (ended sessions up to the purge), no progress.
  const all = await backend.state({ endedWithinMs: Number.MAX_SAFE_INTEGER, progressLimit: 0 });
  if (all === null || all.revision !== since) return full();
  let newest = 0;
  for (const s of all.sessions) newest = Math.max(newest, s.lastEventAt, s.endedAt ?? 0);
  const crossed = all.sessions.some(
    (s) =>
      s.state === 'ended' &&
      s.endedAt !== null &&
      s.endedAt > newest - windowMs &&
      s.endedAt <= all.now - windowMs,
  );
  return crossed ? full() : null;
}

/**
 * Build the Hono app. `resolve` supplies the platform runtime per request
 * (Cloudflare needs the request's env; Node/Vercel return a constant).
 * Only `/api/*` is routed here; entries add static file serving.
 */
export function createApp(resolve: RuntimeResolver): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('/api/*', async (c, next) => {
    c.set('rt', await resolve(c));
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const readAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!(await isReadAuthed(c, c.var.rt.readToken))) return err(c, 'unauthorized', 401);
    await next();
  };

  const writeAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const host = await findWriteHost(c.req.header('authorization'), c.var.rt.writeTokens);
    if (host === null) return err(c, 'unauthorized', 401);
    c.set('host', host);
    await next();
  };

  app.get('/api/health', (c) =>
    c.json({ ok: true, version: c.var.rt.version, driver: c.var.rt.driverName }),
  );

  app.post('/api/login', limitBody(LOGIN_BODY_MAX_BYTES), async (c) => {
    const rt = c.var.rt;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 'bad_request', 400);
    }
    const token =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).token
        : undefined;
    if (typeof token !== 'string') return err(c, 'bad_request', 400);
    const ok = rt.readToken !== '' && (await constantTimeEqual(token, rt.readToken));
    if (!ok) {
      await sleep(LOGIN_FAIL_DELAY_MS);
      return err(c, 'unauthorized', 401);
    }
    setCookie(c, COOKIE_NAME, await makeReadCookie(rt.readToken, Date.now() + COOKIE_MAX_AGE_S * 1000), {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE_S,
      secure: rt.secureCookies ?? isHttps(c),
    });
    return c.body(null, 204);
  });

  app.post('/api/logout', (c) => {
    deleteCookie(c, COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: c.var.rt.secureCookies ?? isHttps(c),
    });
    return c.body(null, 204);
  });

  app.get('/api/me', readAuth, (c) => c.body(null, 204));

  app.get('/api/state', readAuth, async (c) => {
    const res = await stateFor(
      c.var.rt.backend,
      parseSince(c.req.query('since')),
      parseEnded(c.req.query('ended')),
      PROGRESS_CARD,
    );
    if (res === null) return c.body(null, 304);
    return c.json(res);
  });

  // Keys contain "/"; clients send encodeURIComponent(key). Hono decodes the
  // param once; `{.+}` also tolerates unencoded slashes.
  app.get('/api/sessions/:key{.+}', readAuth, async (c) => {
    const view = await c.var.rt.backend.session(c.req.param('key'));
    if (view === null) return err(c, 'not_found', 404);
    return c.json(view);
  });

  // Auth first (headers only), so unauthenticated callers never get a body read.
  app.post('/api/ingest', writeAuth, limitBody(INGEST_BODY_MAX_BYTES), async (c) => {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return err(c, 'bad_request', 400);
    }
    if (Array.isArray(body) && body.length > INGEST_MAX_BATCH) return err(c, 'too_large', 413);
    let parsed: ReturnType<typeof parseEnvelopes>;
    try {
      parsed = parseEnvelopes(body);
    } catch (e) {
      if (e instanceof TooManyEnvelopesError) return err(c, 'too_large', 413);
      throw e;
    }
    const r = await c.var.rt.backend.ingest(parsed.envelopes, c.var.host);
    const out: IngestResult = {
      accepted: r.accepted,
      ignored: parsed.ignored + r.ignored,
      revision: r.revision,
    };
    return c.json(out);
  });

  app.all('/api/*', (c) => err(c, 'not_found', 404));

  app.onError((e, c) => {
    console.error('[jfm] request failed:', e);
    return err(c, 'internal', 500);
  });

  return app;
}
