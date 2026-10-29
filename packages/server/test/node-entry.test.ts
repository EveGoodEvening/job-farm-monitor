// T43: Node/Railway app (node-sqlite file) incl. static files + SPA fallback.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeApp, defaultDbPath } from '../src/entry.node.js';
import { READ_TOKEN, WRITE_TOKENS, defineApiSuite } from './api-suite.js';

const dir = mkdtempSync(join(tmpdir(), 'jfm-node-'));
const web = join(dir, 'web');
mkdirSync(join(web, 'assets'), { recursive: true });
writeFileSync(join(web, 'index.html'), '<!doctype html><title>jfm</title>');
writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
const { app, backend } = createNodeApp({
  dbPath: join(dir, 'nested', 'jfm.sqlite'),
  webDist: web,
  readToken: READ_TOKEN,
  writeTokens: WRITE_TOKENS,
});

afterAll(async () => {
  await backend.store.driver.close?.();
  rmSync(dir, { recursive: true, force: true });
});

defineApiSuite('Node entry (node-sqlite file)', async () => ({
  driver: 'node-sqlite',
  https: false,
  fetch: async (path, init) => app.request(`http://localhost${path}`, init),
}));

describe('Node entry static files', () => {
  it('serves index.html at / and for extensionless client routes', async () => {
    for (const path of ['/', '/some/route']) {
      const res = await app.request(`http://localhost${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('<title>jfm</title>');
    }
  });

  it('serves assets and 404s missing files', async () => {
    const js = await app.request('http://localhost/assets/app.js');
    expect(js.status).toBe(200);
    expect(await js.text()).toBe('console.log(1)');
    expect((await app.request('http://localhost/assets/missing.js')).status).toBe(404);
  });

  it('does not serve static files under /api', async () => {
    const res = await app.request('http://localhost/api/index.html');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('defaultDbPath', () => {
  it('prefers JFM_DB_PATH, then the Railway volume, then ./data', () => {
    expect(defaultDbPath({ JFM_DB_PATH: '/x/db.sqlite' })).toBe('/x/db.sqlite');
    expect(defaultDbPath({ RAILWAY_VOLUME_MOUNT_PATH: '/data' })).toBe('/data/jfm.sqlite');
    expect(defaultDbPath({})).toBe('data/jfm.sqlite');
  });
});
