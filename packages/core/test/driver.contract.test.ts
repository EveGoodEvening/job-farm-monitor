import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../src/types.js';
import { DRIVER_CASES } from './helpers.js';

describe.each(DRIVER_CASES)('SqlDriver contract: $name', (dc) => {
  let driver: SqlDriver;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ driver, cleanup } = await dc.make());
    await driver.exec(`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, n INTEGER, f REAL, x TEXT)`);
  });
  afterEach(async () => cleanup());

  it('reports its name', () => {
    expect(['node-sqlite', 'libsql']).toContain(driver.name);
  });

  it('creating an existing table with IF NOT EXISTS is a no-op', async () => {
    await expect(driver.exec(`CREATE TABLE IF NOT EXISTS t (id INTEGER)`)).resolves.toMatchObject({ rows: [] });
  });

  it('inserts with positional params and reports changes', async () => {
    const r = await driver.exec(`INSERT INTO t (name, n, f, x) VALUES (?, ?, ?, ?)`, ['a', 1_761_721_234_567, 1.5, null]);
    expect(r).toEqual({ rows: [], changes: 1 });
    const dup = await driver.exec(`INSERT OR IGNORE INTO t (name, n) VALUES (?, ?)`, ['a', 2]);
    expect(dup.changes).toBe(0);
    await driver.exec(`INSERT INTO t (name, n) VALUES ('b', 2), ('c', 3)`);
    const upd = await driver.exec(`UPDATE t SET n = n + 1 WHERE n < ?`, [10]);
    expect(upd.changes).toBe(2);
  });

  it('returns plain row objects with JS numbers / strings / null', async () => {
    await driver.exec(`INSERT INTO t (name, n, f, x) VALUES (?, ?, ?, ?)`, ['a', 1_761_721_234_567, 1.5, null]);
    const { rows, changes } = await driver.exec(`SELECT name, n, f, x FROM t WHERE name = ?`, ['a']);
    expect(changes).toBe(0);
    expect(rows).toEqual([{ name: 'a', n: 1_761_721_234_567, f: 1.5, x: null }]);
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
    expect(typeof rows[0]!.n).toBe('number');
    const empty = await driver.exec(`SELECT * FROM t WHERE name = ?`, ['nope']);
    expect(empty.rows).toEqual([]);
  });

  it('supports window functions (used by Store.state)', async () => {
    await driver.exec(`INSERT INTO t (name, n) VALUES ('a', 1), ('b', 1), ('c', 2)`);
    const { rows } = await driver.exec(
      `SELECT name FROM (SELECT name, ROW_NUMBER() OVER (PARTITION BY n ORDER BY name DESC) rn FROM t) WHERE rn <= 1 ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(['b', 'c']);
  });

  it('writeTx commits on resolve and returns the value', async () => {
    const v = await driver.writeTx(async (exec) => {
      await exec(`INSERT INTO t (name) VALUES (?)`, ['in-tx']);
      const r = await exec(`SELECT COUNT(*) AS c FROM t`);
      return r.rows[0]!.c;
    });
    expect(v).toBe(1);
    const { rows } = await driver.exec(`SELECT name FROM t`);
    expect(rows).toEqual([{ name: 'in-tx' }]);
  });

  it('writeTx rolls back and rethrows on reject', async () => {
    await driver.exec(`INSERT INTO t (name) VALUES ('keep')`);
    await expect(
      driver.writeTx(async (exec) => {
        await exec(`INSERT INTO t (name) VALUES ('gone')`);
        await exec(`UPDATE t SET n = 99`);
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const { rows } = await driver.exec(`SELECT name, n FROM t ORDER BY id`);
    expect(rows).toEqual([{ name: 'keep', n: null }]);
  });

  it('writeTx rolls back on SQL errors and stays usable', async () => {
    await expect(
      driver.writeTx(async (exec) => {
        await exec(`INSERT INTO t (name) VALUES ('x')`);
        await exec(`INSERT INTO t (name) VALUES ('x')`); // UNIQUE violation
      }),
    ).rejects.toThrow();
    expect((await driver.exec(`SELECT COUNT(*) AS c FROM t`)).rows[0]!.c).toBe(0);
    await driver.writeTx(async (exec) => void (await exec(`INSERT INTO t (name) VALUES ('y')`)));
    expect((await driver.exec(`SELECT COUNT(*) AS c FROM t`)).rows[0]!.c).toBe(1);
  });

  it('rejects invalid SQL', async () => {
    await expect(driver.exec(`SELEC nonsense`)).rejects.toThrow();
  });
});
