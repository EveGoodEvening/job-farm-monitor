// T42: runs inside workerd (npm run test:workers, via heavy-gate) against
// wrangler.jsonc: Worker -> JfmStore Durable Object -> DO SQLite driver.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DO_INSTANCE_NAME, Store } from '@jfm/core';
import { doSqliteDriver } from '../src/drivers/do-sqlite.js';
import type { Env, JfmStore } from '../src/entry.cloudflare.js';
import { READ_TOKEN, WRITE_TOKEN_A, claude, defineApiSuite, sid } from './api-suite.js';

const testEnv = env as unknown as Env;

defineApiSuite('Cloudflare Worker + JfmStore DO (do-sqlite)', async () => ({
  driver: 'do-sqlite',
  https: true,
  fetch: (path, init) => SELF.fetch(`https://jfm.example.com${path}`, init),
}));

describe('Cloudflare specifics', () => {
  const post = (body: unknown, token = WRITE_TOKEN_A) =>
    SELF.fetch('https://jfm.example.com/api/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string, token = READ_TOKEN) =>
    SELF.fetch(`https://jfm.example.com${path}`, { headers: { authorization: `Bearer ${token}` } });

  it('ingest two batches -> state -> 304 with since -> 401 with a wrong token', async () => {
    const id = sid('cf');
    expect((await post([claude(id, { hook_event_name: 'SessionStart' })])).status).toBe(200);
    const second = await post([
      claude(id, { hook_event_name: 'UserPromptSubmit', prompt: 'hello workerd' }),
      claude(id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } }),
    ]);
    expect(second.status).toBe(200);
    const { revision } = (await second.json()) as { revision: number };

    const res = await get('/api/state');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: number; sessions: { sessionId: string; state: string; stateKind: string }[] };
    expect(body.revision).toBe(revision);
    expect(body.sessions.find((s) => s.sessionId === id)).toMatchObject({ state: 'blocked', stateKind: 'permission' });

    expect((await get(`/api/state?since=${revision}`)).status).toBe(304);
    expect((await get('/api/state', 'wrong')).status).toBe(401);
    expect((await post([], 'wrong')).status).toBe(401);
  });

  it('all requests share the single DO instance (idFromName)', async () => {
    const stub = testEnv.STORE.get(testEnv.STORE.idFromName(DO_INSTANCE_NAME));
    const id = sid('rpc');
    await post([claude(id, { hook_event_name: 'SessionStart' })]);
    const view = await stub.session(`hostA/claude/${id}`);
    expect(view?.sessionId).toBe(id);
    const direct = await runInDurableObject(stub, async (instance: JfmStore) => instance.session(`hostA/claude/${id}`));
    expect(direct?.key).toBe(`hostA/claude/${id}`);
  });

  it('do-sqlite driver: changes, rows and writeTx rollback', async () => {
    const stub = testEnv.STORE.get(testEnv.STORE.idFromName('driver-test'));
    await runInDurableObject(stub, async (_instance: JfmStore, state) => {
      const driver = doSqliteDriver(state.storage);
      expect(driver.name).toBe('do-sqlite');
      await driver.exec('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, n INTEGER)');
      expect((await driver.exec('INSERT OR IGNORE INTO t (id, n) VALUES (?, ?)', ['a', 1])).changes).toBeGreaterThan(0);
      expect((await driver.exec('INSERT OR IGNORE INTO t (id, n) VALUES (?, ?)', ['a', 2])).changes).toBe(0);
      expect((await driver.exec('SELECT id, n FROM t')).rows).toEqual([{ id: 'a', n: 1 }]);

      await expect(
        driver.writeTx(async (exec) => {
          await exec('INSERT INTO t (id, n) VALUES (?, ?)', ['b', 2]);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect((await driver.exec('SELECT id FROM t ORDER BY id')).rows).toEqual([{ id: 'a' }]);

      const r = await driver.writeTx(async (exec) => {
        await exec('INSERT INTO t (id, n) VALUES (?, ?)', ['c', 3]);
        return (await exec('SELECT COUNT(*) AS c FROM t')).rows[0];
      });
      expect(r).toEqual({ c: 2 });
    });
  });

  it('Store on do-sqlite: init is idempotent and ingest dedupes', async () => {
    const stub = testEnv.STORE.get(testEnv.STORE.idFromName('store-test'));
    await runInDurableObject(stub, async (_instance: JfmStore, state) => {
      const store = new Store(doSqliteDriver(state.storage));
      await store.init();
      await store.init();
      const id = sid('store');
      const ev = claude(id, { hook_event_name: 'SessionStart' });
      const a = await store.ingest([ev], 'h');
      const b = await store.ingest([ev], 'h');
      expect(a.accepted).toBe(1);
      expect(b).toEqual({ accepted: 0, ignored: 1, revision: a.revision });
    });
  });

  it('upgrades legacy raw events without losing deduplication or dashboard state', async () => {
    const stub = testEnv.STORE.get(testEnv.STORE.idFromName('privacy-upgrade'));
    await runInDurableObject(stub, async (_instance: JfmStore, state) => {
      const driver = doSqliteDriver(state.storage);
      const store = new Store(driver);
      await store.init();
      const id = sid('legacy');
      const event = claude(id, { hook_event_name: 'UserPromptSubmit', prompt: 'Visible title' });
      const ingested = await store.ingest([event], 'h');
      const view = await store.session(`h/claude/${id}`);
      await driver.exec("ALTER TABLE events ADD COLUMN raw_json TEXT NOT NULL DEFAULT ''");
      await driver.exec('UPDATE events SET raw_json = ? WHERE id = ?', ['private legacy payload', event.id]);
      await driver.exec("UPDATE meta SET v = '2' WHERE k = 'schema_version'");

      const upgraded = new Store(driver);
      await upgraded.init();
      expect((await driver.exec('PRAGMA table_info(events)')).rows.map((r) => r.name)).not.toContain('raw_json');
      expect(JSON.stringify((await driver.exec('SELECT * FROM events')).rows)).not.toContain('private legacy payload');
      expect(await upgraded.ingest([event], 'h')).toEqual({ accepted: 0, ignored: 1, revision: ingested.revision });
      expect(await upgraded.session(`h/claude/${id}`)).toEqual(view);
    });
  });
});
