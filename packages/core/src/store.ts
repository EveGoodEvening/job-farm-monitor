// SQLite-backed state store shared by all three platforms. Platform-neutral:
// no node:* imports (runs inside the Cloudflare Durable Object too).
import {
  ENDED_RETENTION_MS,
  STALE_MS,
  EVENTS_RETENTION_MS,
  PROGRESS_KEEP,
  PURGE_EVERY_REVISIONS,
  SCHEMA_VERSION,
  SILENT_HIDE_MS,
} from './constants.js';
import { sessionKey } from './key.js';
import { normalize } from './normalize/index.js';
import { applyEvent } from './reducer.js';
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from './schema.js';
import { isRecord, str } from './text.js';
import type {
  AgentKind,
  BlockedKind,
  CanonicalEvent,
  Envelope,
  IngestResult,
  ProgressLine,
  SessionRow,
  SessionState,
  SessionView,
  SqlDriver,
  SqlExec,
  StateBackend,
  StateOptions,
  StateResponse,
  SubagentView,
} from './types.js';

export interface StoreOptions {
  /** Clock override for tests; defaults to Date.now. */
  now?: () => number;
}

const SESSION_COLUMNS = [
  'key', 'host', 'agent', 'session_id', 'cwd', 'project', 'title', 'model', 'state',
  'state_kind', 'state_msg', 'state_since', 'last_event_at', 'started_at', 'ended_at',
  'last_message', 'subagents_json', 'herdr_pane_id', 'herdr_tab_id', 'herdr_workspace_id',
  'tmux_pane', 'hostname', 'delayed', 'last_ts', 'state_agent',
] as const satisfies readonly (keyof SessionRow)[];

const UPSERT_SESSION = `INSERT OR REPLACE INTO sessions (${SESSION_COLUMNS.join(', ')}) VALUES (${SESSION_COLUMNS.map(() => '?').join(', ')})`;

const TRIM_PROGRESS = `DELETE FROM progress WHERE session_key = ? AND seq NOT IN (
  SELECT seq FROM progress WHERE session_key = ? ORDER BY ts DESC, seq DESC LIMIT ?)`;

// --- row conversion ---------------------------------------------------------

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : n(v));

function toRow(r: Record<string, unknown>): SessionRow {
  return {
    key: String(r.key),
    host: String(r.host),
    agent: String(r.agent) as AgentKind,
    session_id: String(r.session_id),
    cwd: s(r.cwd),
    project: s(r.project),
    title: s(r.title),
    model: s(r.model),
    state: String(r.state) as SessionState,
    state_kind: s(r.state_kind) as BlockedKind | null,
    state_msg: s(r.state_msg),
    state_since: n(r.state_since),
    last_event_at: n(r.last_event_at),
    started_at: n(r.started_at),
    ended_at: nn(r.ended_at),
    last_message: s(r.last_message),
    subagents_json: s(r.subagents_json) ?? '{}',
    herdr_pane_id: s(r.herdr_pane_id),
    herdr_tab_id: s(r.herdr_tab_id),
    herdr_workspace_id: s(r.herdr_workspace_id),
    tmux_pane: s(r.tmux_pane),
    hostname: s(r.hostname),
    delayed: n(r.delayed) ? 1 : 0,
    last_ts: n(r.last_ts),
    state_agent: s(r.state_agent),
  };
}

function subagentsOf(json: string): SubagentView[] {
  try {
    const map: unknown = JSON.parse(json);
    if (!isRecord(map)) return [];
    return Object.entries(map)
      .filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]))
      .map(([id, v]) => ({ id, type: String(v.type ?? ''), since: n(v.since) }))
      .sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

function toView(row: SessionRow, progress: ProgressLine[]): SessionView {
  return {
    key: row.key,
    host: row.host,
    agent: row.agent,
    sessionId: row.session_id,
    cwd: row.cwd,
    project: row.project,
    title: row.title,
    model: row.model,
    state: row.state,
    stateKind: row.state_kind,
    stateMsg: row.state_msg,
    stateSince: row.state_since,
    lastEventAt: row.last_event_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastMessage: row.last_message,
    subagents: subagentsOf(row.subagents_json),
    herdrPaneId: row.herdr_pane_id,
    herdrTabId: row.herdr_tab_id,
    herdrWorkspaceId: row.herdr_workspace_id,
    hostname: row.hostname,
    delayed: row.delayed === 1,
    progress,
  };
}

function toProgress(r: Record<string, unknown>): ProgressLine {
  return { ts: n(r.ts), text: String(r.text), agentType: s(r.agent_type) };
}

/** Source event name stored in events.type (hook_event_name / omp type). */
function rawType(env: Envelope): string {
  const p = env.payload;
  if (!isRecord(p)) return 'unknown';
  return str(p.hook_event_name) ?? str(p.type) ?? 'unknown';
}

/** Session id the envelope talks about, before normalization (for events.session_key). */
function rawSessionId(env: Envelope): string | undefined {
  const p = env.payload;
  if (!isRecord(p)) return undefined;
  return str(p.session_id) ?? str(p.sessionId);
}

/**
 * Codex interactive sessions never send SessionEnd (/exit, /clear): a new
 * Codex session starting (source startup|clear) in the same terminal pane
 * replaces the older one. Claude sends SessionEnd itself (and nested
 * `claude -p` runs share the pane), so only Codex is reaped.
 */
const REPLACING_SOURCES: ReadonlySet<string> = new Set(['startup', 'clear']);
export const REPLACED_END_REASON = 'replaced';

/** States in which a session can be waiting at its prompt (nothing running). */
const AT_REST: ReadonlySet<SessionState> = new Set(['idle', 'done', 'error']);

/**
 * Whether a Codex session_start (source `source`, received at `receivedAt`)
 * replaces `old` on the same pane. `clear` always does (only the pane's own
 * foreground session can /clear). `startup` is also what a nested or parallel
 * `codex exec` sends (it inherits the pane env), so it replaces only a session
 * at rest, or one that has been silent for STALE_MS (killed mid-turn).
 */
function replaces(old: SessionRow, source: string, receivedAt: number): boolean {
  if (source === 'clear') return true;
  return AT_REST.has(old.state) || receivedAt - old.last_event_at > STALE_MS;
}

/** Pane column/value a replacing Codex session_start identifies, else null. */
function replacedPane(
  env: Envelope,
  ev: CanonicalEvent,
): { column: 'herdr_pane_id' | 'tmux_pane'; value: string; source: string } | null {
  if (env.agent !== 'codex' || ev.type !== 'session_start') return null;
  const source = ev.source;
  if (!source || !REPLACING_SOURCES.has(source)) return null;
  // herdr pane ids are preferred: tmux pane ids are only unique per tmux server.
  if (env.env?.herdr_pane_id) return { column: 'herdr_pane_id', value: env.env.herdr_pane_id, source };
  if (env.env?.tmux_pane) return { column: 'tmux_pane', value: env.env.tmux_pane, source };
  return null;
}

async function readRevision(exec: SqlExec): Promise<number> {
  const { rows } = await exec(`SELECT v FROM meta WHERE k = 'revision'`);
  return rows[0] ? n(rows[0].v) : 0;
}

// -----------------------------------------------------------------------------

/** SQLite-backed state store shared by all three platforms. */
export class Store implements StateBackend {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly driver: SqlDriver,
    readonly options: StoreOptions = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /**
   * Internal async mutex: every operation (reads included, so a snapshot
   * never interleaves with a write transaction on single-connection drivers)
   * runs strictly after the previous one settles.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Create tables/indexes (idempotent) and seed meta. Call once before use. */
  async init(): Promise<void> {
    await this.serialize(() =>
      this.driver.writeTx(async (exec) => {
        for (const sql of SCHEMA_STATEMENTS) await exec(sql);
        const { rows } = await exec(`SELECT v FROM meta WHERE k = 'schema_version'`);
        if (rows[0]) {
          const stored = n(rows[0].v);
          for (const m of SCHEMA_MIGRATIONS) {
            if (m.version > stored) for (const sql of m.statements) await exec(sql);
          }
        }
        await exec(`INSERT OR IGNORE INTO meta (k, v) VALUES ('revision', '0')`);
        await exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', ?)`, [
          String(SCHEMA_VERSION),
        ]);
      }),
    );
  }

  /** Serialized (internal mutex) + one writeTx per call. */
  async ingest(envelopes: Envelope[], host: string): Promise<IngestResult> {
    const receivedAt = this.now();
    return this.serialize(() =>
      this.driver.writeTx(async (exec) => {
        let accepted = 0;
        let ignored = 0;
        let changed = false;
        const cache = new Map<string, SessionRow | null>();
        const dirty = new Set<string>();
        const progressTouched = new Set<string>();

        const load = async (key: string): Promise<SessionRow | null> => {
          if (cache.has(key)) return cache.get(key) ?? null;
          const { rows } = await exec(`SELECT * FROM sessions WHERE key = ?`, [key]);
          const row = rows[0] ? toRow(rows[0]) : null;
          cache.set(key, row);
          return row;
        };

        for (const env of envelopes) {
          const sid = rawSessionId(env);
          const rawKey = sid ? sessionKey(host, env.agent, sid) : null;
          const ins = await exec(
            `INSERT OR IGNORE INTO events (id, session_key, ts, received_at, type) VALUES (?, ?, ?, ?, ?)`,
            [env.id, rawKey, env.ts, receivedAt, rawType(env)],
          );
          if (ins.changes === 0) {
            ignored += 1;
            continue;
          }
          accepted += 1;

          for (const ev of normalize(env)) {
            const key = sessionKey(host, env.agent, ev.sessionId);
            const prev = await load(key);
            const meta = { host, agent: env.agent, ts: env.ts, receivedAt, env: env.env, hostname: env.hostname };
            const res = applyEvent(prev, ev, meta);

            const pane = replacedPane(env, ev);
            if (pane) {
              // Candidates: rows in the DB on that pane plus rows only in this
              // batch's cache; `load` returns the freshest version of each.
              const { rows } = await exec(
                `SELECT key FROM sessions WHERE host = ? AND agent = ? AND state != 'ended' AND ${pane.column} = ?`,
                [host, env.agent, pane.value],
              );
              const keys = new Set([...rows.map((r) => String(r.key)), ...cache.keys()]);
              keys.delete(key);
              for (const k of keys) {
                const old = await load(k);
                if (!old || old.agent !== env.agent || old.state === 'ended') continue;
                // Only an older session on the same pane is replaced.
                if (old[pane.column] !== pane.value || old.started_at > env.ts) continue;
                // ...and only when the new one is its foreground replacement,
                // not a nested/parallel `codex exec` in the same pane.
                if (!replaces(old, pane.source, receivedAt)) continue;
                const end = applyEvent(
                  old,
                  { type: 'session_end', sessionId: old.session_id, reason: REPLACED_END_REASON },
                  { host, agent: env.agent, ts: Math.max(env.ts, old.last_ts), receivedAt },
                );
                if (!end.changed) continue;
                changed = true;
                cache.set(k, end.session);
                dirty.add(k);
              }
            }

            if (!res.changed) continue;
            changed = true;
            cache.set(key, res.session);
            dirty.add(key);
            if (res.progressLine) {
              const pl = res.progressLine;
              await exec(`INSERT INTO progress (session_key, ts, text, agent_type) VALUES (?, ?, ?, ?)`, [
                key,
                pl.ts,
                pl.text,
                pl.agentType,
              ]);
              progressTouched.add(key);
            }
          }
        }

        for (const key of dirty) {
          const row = cache.get(key);
          if (row) await exec(UPSERT_SESSION, SESSION_COLUMNS.map((c) => row[c]));
        }
        for (const key of progressTouched) await exec(TRIM_PROGRESS, [key, key, PROGRESS_KEEP]);

        let revision = await readRevision(exec);
        if (changed) {
          revision += 1;
          await exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('revision', ?)`, [String(revision)]);
          if (revision % PURGE_EVERY_REVISIONS === 0) await purgeWith(exec, receivedAt);
        }
        return { accepted, ignored, revision };
      }),
    );
  }

  async state(opts: StateOptions): Promise<StateResponse | null> {
    return this.serialize(async () => {
      const exec: SqlExec = (sql, params) => this.driver.exec(sql, params);
      const revision = await readRevision(exec);
      if (opts.since !== undefined && opts.since === revision) return null;
      const now = this.now();
      const { rows } = await exec(
        `SELECT * FROM sessions
         WHERE (state != 'ended' AND last_event_at > ?) OR (state = 'ended' AND ended_at > ?)
         ORDER BY last_event_at DESC, key ASC`,
        [now - (opts.silentWithinMs ?? SILENT_HIDE_MS), now - opts.endedWithinMs],
      );
      const limit = Math.max(0, Math.floor(opts.progressLimit));
      const byKey = new Map<string, ProgressLine[]>();
      if (rows.length > 0 && limit > 0) {
        const pr = await exec(
          `SELECT session_key, ts, text, agent_type FROM (
             SELECT session_key, ts, text, agent_type, seq,
               ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY ts DESC, seq DESC) AS rn
             FROM progress)
           WHERE rn <= ? ORDER BY session_key, ts DESC, seq DESC`,
          [limit],
        );
        for (const r of pr.rows) {
          const k = String(r.session_key);
          let list = byKey.get(k);
          if (!list) byKey.set(k, (list = []));
          list.push(toProgress(r));
        }
      }
      const sessions = rows.map((r) => {
        const row = toRow(r);
        return toView(row, byKey.get(row.key) ?? []);
      });
      return { revision, now, sessions };
    });
  }

  async session(key: string): Promise<SessionView | null> {
    return this.serialize(async () => {
      const exec: SqlExec = (sql, params) => this.driver.exec(sql, params);
      const { rows } = await exec(`SELECT * FROM sessions WHERE key = ?`, [key]);
      if (!rows[0]) return null;
      const pr = await exec(
        `SELECT ts, text, agent_type FROM progress WHERE session_key = ? ORDER BY ts DESC, seq DESC LIMIT ?`,
        [key, PROGRESS_KEEP],
      );
      return toView(toRow(rows[0]), pr.rows.map(toProgress));
    });
  }

  /** Delete events older than 7d and sessions ended > 24h ago (with their rows). */
  async purge(now?: number): Promise<void> {
    const at = now ?? this.now();
    await this.serialize(() => this.driver.writeTx((exec) => purgeWith(exec, at)));
  }
}

async function purgeWith(exec: SqlExec, now: number): Promise<void> {
  const endedBefore = now - ENDED_RETENTION_MS;
  const gone = `SELECT key FROM sessions WHERE state = 'ended' AND ended_at IS NOT NULL AND ended_at < ?`;
  await exec(`DELETE FROM events WHERE received_at < ?`, [now - EVENTS_RETENTION_MS]);
  await exec(`DELETE FROM progress WHERE session_key IN (${gone})`, [endedBefore]);
  await exec(`DELETE FROM events WHERE session_key IN (${gone})`, [endedBefore]);
  await exec(`DELETE FROM sessions WHERE key IN (${gone})`, [endedBefore]);
}
