// Imported only via `@jfm/core/drivers/node-sqlite` (uses node:sqlite).
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ExecResult, SqlDriver, SqlExec, SqlValue } from '../types.js';

/** `path` is a file path or ":memory:". name === "node-sqlite". */
export function nodeSqliteDriver(path: string): SqlDriver {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:' && path !== '') db.exec('PRAGMA journal_mode = WAL');

  const cache = new Map<string, { stmt: StatementSync; reader: boolean }>();
  const prepare = (sql: string) => {
    let entry = cache.get(sql);
    if (!entry) {
      const stmt = db.prepare(sql);
      entry = { stmt, reader: stmt.columns().length > 0 };
      cache.set(sql, entry);
    }
    return entry;
  };

  const exec: SqlExec = async (sql, params = []) => {
    const { stmt, reader } = prepare(sql);
    const args = params as SqlValue[];
    if (reader) {
      const rows = stmt.all(...args).map((r) => ({ ...r }) as Record<string, unknown>);
      return { rows, changes: 0 } satisfies ExecResult;
    }
    const r = stmt.run(...args);
    return { rows: [], changes: Number(r.changes) };
  };

  return {
    name: 'node-sqlite',
    exec,
    async writeTx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(exec);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
    },
    close() {
      cache.clear();
      if (db.isOpen) db.close();
    },
  };
}
