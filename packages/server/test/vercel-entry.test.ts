// T44: the Vercel entry (libSQL `file:`) wrapped in @hono/node-server, driven
// over real HTTP with the same suite as app.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { READ_TOKEN, WRITE_TOKENS, defineApiSuite } from './api-suite.js';

defineApiSuite('Vercel entry (libsql file:) via @hono/node-server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jfm-vercel-'));
  process.env.TURSO_DATABASE_URL = `file:${join(dir, 'dev.db')}`;
  process.env.READ_TOKEN = READ_TOKEN;
  process.env.WRITE_TOKENS = WRITE_TOKENS;
  // src/index.ts is what the Vercel Hono preset loads.
  const { default: app } = await import('../src/index.js');
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    driver: 'libsql',
    https: false,
    fetch: (path, init) => fetch(`${base}${path}`, init),
    async cleanup() {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
