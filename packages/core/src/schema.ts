/**
 * DDL statements, one per element (drivers execute one statement per call),
 * all `CREATE ... IF NOT EXISTS`. Store.init() runs them in order and sets
 * meta.schema_version = SCHEMA_VERSION.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    cwd TEXT,
    project TEXT,
    title TEXT,
    model TEXT,
    state TEXT NOT NULL,
    state_kind TEXT,
    state_msg TEXT,
    state_since INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_message TEXT,
    subagents_json TEXT NOT NULL DEFAULT '{}',
    herdr_pane_id TEXT,
    herdr_tab_id TEXT,
    herdr_workspace_id TEXT,
    tmux_pane TEXT,
    hostname TEXT,
    delayed INTEGER NOT NULL DEFAULT 0,
    last_ts INTEGER NOT NULL DEFAULT 0,
    state_agent TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_state_ended ON sessions (state, ended_at)`,
  `CREATE INDEX IF NOT EXISTS sessions_last_event ON sessions (last_event_at)`,
  `CREATE TABLE IF NOT EXISTS progress (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    ts INTEGER NOT NULL,
    text TEXT NOT NULL,
    agent_type TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS progress_session_ts ON progress (session_key, ts, seq)`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_key TEXT,
    ts INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    type TEXT NOT NULL,
    raw_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_received ON events (received_at)`,
  `CREATE INDEX IF NOT EXISTS events_session ON events (session_key)`,
];

/**
 * Upgrades for databases created by an older schema version (CREATE TABLE IF
 * NOT EXISTS leaves their tables as they were). Store.init() runs every
 * migration whose `version` is above the stored meta.schema_version, in order;
 * a fresh database (no stored version) already has the current tables.
 */
export const SCHEMA_MIGRATIONS: readonly { version: number; statements: readonly string[] }[] = [
  {
    version: 2,
    statements: [
      `ALTER TABLE sessions ADD COLUMN last_ts INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN state_agent TEXT`,
    ],
  },
];
