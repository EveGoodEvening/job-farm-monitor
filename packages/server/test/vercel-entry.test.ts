// T44: the Vercel entry (libSQL `file:`) wrapped in @hono/node-server, driven
// over real HTTP with the same suite as app.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterAll, describe, expect, it } from 'vitest';
import { READ_TOKEN, WRITE_TOKENS, defineApiSuite } from './api-suite.js';

const dir = mkdtempSync(join(tmpdir(), 'jfm-vercel-'));
const web = join(dir, 'web');
mkdirSync(join(web, 'assets'), { recursive: true });
writeFileSync(join(web, 'index.html'), '<!doctype html><title>jfm</title>');
writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
process.env.TURSO_DATABASE_URL = `file:${join(dir, 'dev.db')}`;
process.env.READ_TOKEN = READ_TOKEN;
process.env.WRITE_TOKENS = WRITE_TOKENS;
process.env.JFM_WEB_DIST = web;
// src/index.ts is what the Vercel Hono preset loads.
const { default: app } = await import('../src/index.js');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

defineApiSuite('Vercel entry (libsql file:) via @hono/node-server', async () => {
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
    },
  };
});

// Vercel's CDN does not see the build-time copy in public/, so the function serves the dashboard.
describe('Vercel entry static files', () => {
  it('serves index.html at / and for client routes, and assets', async () => {
    for (const path of ['/', '/some/route']) {
      const res = await app.request(`http://localhost${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain('<title>jfm</title>');
    }
    const js = await app.request('http://localhost/assets/app.js');
    expect(js.status).toBe(200);
    expect(await js.text()).toBe('console.log(1)');
    expect((await app.request('http://localhost/api/index.html')).status).toBe(404);
  });
});
