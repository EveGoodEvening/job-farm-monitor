// Cloudflare Durable Object SQLite driver (ctx.storage.sql).
//
// Atomicity: `writeTx` runs `fn` inside `storage.transaction()`, which on
// SQLite-backed Durable Objects rolls back every SQL write made in the closure
// if it throws. Isolation does not depend on SQL transactions anyway: the DO
// runs one request at a time per instance (input gates; storage.sql is
// synchronous, so `fn` never yields to real I/O), and Store serializes every
// operation with its internal promise mutex.
import type { ExecResult, SqlDriver, SqlExec } from '@jfm/core';

export function doSqliteDriver(storage: DurableObjectStorage): SqlDriver {
  const exec: SqlExec = async (sql, params = []) => {
    const cursor = storage.sql.exec(sql, ...params);
    const rows = cursor.toArray().map((r) => ({ ...r }) as Record<string, unknown>);
    return { rows, changes: cursor.rowsWritten } satisfies ExecResult;
  };
  return {
    name: 'do-sqlite',
    exec,
    writeTx(fn) {
      return storage.transaction(() => fn(exec));
    },
  };
}
