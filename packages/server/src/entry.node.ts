// Node / Railway entry: node:sqlite on a volume + static dashboard.
//   JFM_DB_PATH   default ${RAILWAY_VOLUME_MOUNT_PATH:-./data}/jfm.sqlite
//   JFM_WEB_DIST  default <repo>/packages/web/dist (resolved from this file)
//   PORT          default 8787 (Dockerfile sets 8080)
//   HOST          listen address (default: all interfaces; set 127.0.0.1 for local dev)
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { APP_VERSION, DEFAULT_PORT, Store } from '@jfm/core';
import { nodeSqliteDriver } from '@jfm/core/drivers/node-sqlite';
import { createApp, type Runtime } from './app.js';
import { parseWriteTokens } from './auth.js';
import { LocalBackend } from './backend.js';

export interface NodeAppOptions {
  dbPath: string;
  webDist: string;
  readToken: string;
  writeTokens: string | undefined;
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.JFM_DB_PATH || join(env.RAILWAY_VOLUME_MOUNT_PATH || './data', 'jfm.sqlite');
}

/** packages/web/dist relative to this module (src/ and the tsup dist/ both sit one level below packages/server). */
export function defaultWebDist(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.JFM_WEB_DIST || fileURLToPath(new URL('../../web/dist', import.meta.url)));
}

/** Build the Node app: API + static files with SPA fallback to index.html. */
export function createNodeApp(opts: NodeAppOptions): { app: ReturnType<typeof createApp>; backend: LocalBackend } {
  if (opts.dbPath !== ':memory:') mkdirSync(dirname(resolve(opts.dbPath)), { recursive: true });
  const backend = new LocalBackend(new Store(nodeSqliteDriver(opts.dbPath)));
  const runtime: Runtime = {
    backend,
    readToken: opts.readToken,
    writeTokens: parseWriteTokens(opts.writeTokens),
    version: APP_VERSION,
    driverName: backend.driverName,
  };
  const app = createApp(() => runtime);

  if (!existsSync(opts.webDist)) console.warn(`[jfm] web dist not found at ${opts.webDist}`);
  const root = opts.webDist;
  app.get('*', serveStatic({ root }));
  // SPA fallback: extensionless paths (client routes) get index.html.
  app.get('*', async (c, next) => {
    if (/\.[A-Za-z0-9]+$/.test(c.req.path)) return next();
    return serveStatic({ root, path: 'index.html' })(c, next);
  });
  return { app, backend };
}

async function main(): Promise<void> {
  const env = process.env;
  if (!env.READ_TOKEN) console.warn('[jfm] READ_TOKEN is empty: dashboard login is disabled');
  if (!env.WRITE_TOKENS) console.warn('[jfm] WRITE_TOKENS is empty: ingest is disabled');
  const { app, backend } = createNodeApp({
    dbPath: defaultDbPath(env),
    webDist: defaultWebDist(env),
    readToken: env.READ_TOKEN ?? '',
    writeTokens: env.WRITE_TOKENS,
  });
  await backend.init();
  const port = Number(env.PORT || DEFAULT_PORT);
  const server: ServerType = serve({ fetch: app.fetch, port, ...(env.HOST ? { hostname: env.HOST } : {}) }, (info) => {
    console.log(`[jfm] listening on :${info.port} (node-sqlite ${defaultDbPath(env)})`);
  });
  const stop = () => {
    server.close(() => {
      void Promise.resolve(backend.store.driver.close?.()).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error('[jfm] failed to start:', e);
    process.exit(1);
  });
}
