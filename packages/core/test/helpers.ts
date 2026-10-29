import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { libsqlDriver } from '../src/drivers/libsql.js';
import { nodeSqliteDriver } from '../src/drivers/node-sqlite.js';
import type { AgentKind, Envelope, SqlDriver } from '../src/types.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);

export function fixture(agent: AgentKind, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`${agent}/${name}.json`, FIXTURES), 'utf8')) as Record<string, unknown>;
}

export function fixtureNames(agent: AgentKind): string[] {
  return readdirSync(new URL(`${agent}/`, FIXTURES))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

let seq = 0;
export function envelope(agent: AgentKind, payload: unknown, over: Partial<Envelope> = {}): Envelope {
  seq += 1;
  return { v: 1, id: `e-${seq}-${Math.random().toString(36).slice(2)}`, ts: 1_000_000, agent, payload, ...over };
}

export interface DriverCase {
  name: string;
  make(): Promise<{ driver: SqlDriver; cleanup(): Promise<void> }>;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jfm-core-'));
}

/** node-sqlite on a temp file, node-sqlite :memory:, libsql file: (temp dir). */
export const DRIVER_CASES: DriverCase[] = [
  {
    name: 'node-sqlite (file)',
    async make() {
      const dir = tempDir();
      const driver = nodeSqliteDriver(join(dir, 'db.sqlite'));
      return {
        driver,
        async cleanup() {
          await driver.close?.();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'node-sqlite (:memory:)',
    async make() {
      const driver = nodeSqliteDriver(':memory:');
      return { driver, cleanup: async () => void (await driver.close?.()) };
    },
  },
  {
    name: 'libsql (file:)',
    async make() {
      const dir = tempDir();
      const driver = libsqlDriver(createClient({ url: `file:${join(dir, 'db.sqlite')}` }));
      return {
        driver,
        async cleanup() {
          await driver.close?.();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];
