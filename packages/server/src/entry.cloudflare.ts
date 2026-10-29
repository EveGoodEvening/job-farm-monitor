// Cloudflare Worker entry + JfmStore Durable Object (SQLite storage).
// wrangler.jsonc routes /api/* to this Worker first (assets.run_worker_first);
// everything else is served from packages/web/dist by the assets layer.
import { DurableObject } from 'cloudflare:workers';
import {
  APP_VERSION,
  DO_INSTANCE_NAME,
  Store,
  type Envelope,
  type IngestResult,
  type SessionView,
  type StateBackend,
  type StateOptions,
  type StateResponse,
} from '@jfm/core';
import { createApp, type Runtime } from './app.js';
import { parseWriteTokens } from './auth.js';
import { doSqliteDriver } from './drivers/do-sqlite.js';

export interface Env {
  STORE: DurableObjectNamespace<JfmStore>;
  ASSETS: Fetcher;
  READ_TOKEN?: string;
  WRITE_TOKENS?: string;
}

/** Single instance (idFromName(DO_INSTANCE_NAME)) holding all state. */
export class JfmStore extends DurableObject<Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(doSqliteDriver(ctx.storage));
    void ctx.blockConcurrencyWhile(() => this.store.init());
  }

  ingest(envelopes: Envelope[], host: string): Promise<IngestResult> {
    return this.store.ingest(envelopes, host);
  }

  state(opts: StateOptions): Promise<StateResponse | null> {
    return this.store.state(opts);
  }

  session(key: string): Promise<SessionView | null> {
    return this.store.session(key);
  }
}

/** StateBackend over the DO RPC stub. */
export class DoBackend implements StateBackend {
  constructor(private readonly stub: DurableObjectStub<JfmStore>) {}

  async ingest(envelopes: Envelope[], host: string): Promise<IngestResult> {
    return (await this.stub.ingest(envelopes, host)) as IngestResult;
  }

  async state(opts: StateOptions): Promise<StateResponse | null> {
    return (await this.stub.state(opts)) as StateResponse | null;
  }

  async session(key: string): Promise<SessionView | null> {
    return (await this.stub.session(key)) as SessionView | null;
  }
}

// Parsed secrets are cached per env object. The DO stub is created per request:
// Workers I/O objects must not be shared across requests.
const writeTokensCache = new WeakMap<Env, Map<string, string>>();

function runtime(env: Env): Runtime {
  let writeTokens = writeTokensCache.get(env);
  if (!writeTokens) {
    writeTokens = parseWriteTokens(env.WRITE_TOKENS);
    writeTokensCache.set(env, writeTokens);
  }
  return {
    backend: new DoBackend(env.STORE.get(env.STORE.idFromName(DO_INSTANCE_NAME))),
    readToken: env.READ_TOKEN ?? '',
    writeTokens,
    version: APP_VERSION,
    driverName: 'do-sqlite',
  };
}

const app = createApp((c) => runtime(c.env as Env));

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // run_worker_first only sends /api/* here; the fallback keeps the Worker
    // correct if the assets layer ever forwards other paths.
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
