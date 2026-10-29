// Imported only via `@jfm/core/drivers/libsql` (uses @libsql/client).
import type { Client, InStatement, ResultSet } from '@libsql/client';
import type { SqlDriver, SqlExec, SqlValue } from '../types.js';

function toResult(rs: ResultSet) {
  const rows = rs.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    rs.columns.forEach((col, i) => {
      const v = row[i];
      obj[col] = typeof v === 'bigint' ? Number(v) : v;
    });
    return obj;
  });
  return { rows, changes: rs.columns.length > 0 ? 0 : rs.rowsAffected };
}

const stmt = (sql: string, params: readonly SqlValue[] = []): InStatement => ({
  sql,
  args: params as SqlValue[],
});

/** Wrap a libSQL client (Turso URL or `file:`). name === "libsql". */
export function libsqlDriver(client: Client): SqlDriver {
  const exec: SqlExec = async (sql, params) => toResult(await client.execute(stmt(sql, params)));

  return {
    name: 'libsql',
    exec,
    async writeTx(fn) {
      const tx = await client.transaction('write');
      try {
        const txExec: SqlExec = async (sql, params) => toResult(await tx.execute(stmt(sql, params)));
        const result = await fn(txExec);
        await tx.commit();
        return result;
      } catch (err) {
        if (!tx.closed) await tx.rollback().catch(() => undefined);
        throw err;
      } finally {
        tx.close();
      }
    },
    close() {
      client.close();
    },
  };
}
