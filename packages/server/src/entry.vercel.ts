// Vercel entry (Hono framework preset): libSQL / Turso.
//   TURSO_DATABASE_URL  e.g. libsql://<db>.turso.io, or file:./dev.db locally
//   TURSO_AUTH_TOKEN    Turso token (not needed for file:)
//   JFM_WEB_DIST        override the dashboard directory (default packages/server/public)
//
// The dashboard is served by this function, not by Vercel's CDN: the preset's
// static builder collects public/** before the build command has copied
// packages/web/dist there, so it would deploy nothing. vercel.json ships
// public/** with the function via `includeFiles`.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { APP_VERSION, Store } from '@jfm/core';
import { libsqlDriver } from '@jfm/core/drivers/libsql';
import { createApp, type Runtime } from './app.js';
import { parseWriteTokens } from './auth.js';
import { LocalBackend } from './backend.js';
import { serveWeb } from './static.js';

let runtime: Runtime | null = null;

/** Built on the first request (env is read then), cached per instance; Store.init() runs lazily once. */
function getRuntime(): Runtime {
  if (runtime) return runtime;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL is not set');
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  const backend = new LocalBackend(new Store(libsqlDriver(client)));
  runtime = {
    backend,
    readToken: process.env.READ_TOKEN ?? '',
    writeTokens: parseWriteTokens(process.env.WRITE_TOKENS),
    version: APP_VERSION,
    driverName: backend.driverName,
  };
  return runtime;
}

const app = createApp(getRuntime);
// packages/server/public relative to this module (src/ and the tsup dist/ both sit one level below packages/server).
serveWeb(app, resolve(process.env.JFM_WEB_DIST || fileURLToPath(new URL('../public', import.meta.url))));

export default app;
