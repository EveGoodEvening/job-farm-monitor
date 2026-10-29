// Locked constants from docs/todo.md "Locked decisions". Every package imports
// these from `@jfm/core` instead of re-typing numbers.

import type { AgentKind, BlockedKind, CanonicalEventType, SessionState } from './types.js';

export const APP_VERSION = '0.1.0';
export const SCHEMA_VERSION = 3;

// Vocabularies ---------------------------------------------------------------
export const AGENT_KINDS = ['claude', 'codex', 'omp'] as const satisfies readonly AgentKind[];
export const SESSION_STATES = [
  'idle',
  'working',
  'blocked',
  'done',
  'error',
  'ended',
] as const satisfies readonly SessionState[];
export const BLOCKED_KINDS = ['permission', 'question'] as const satisfies readonly BlockedKind[];
export const CANONICAL_EVENT_TYPES = [
  'session_start',
  'prompt',
  'tool_start',
  'progress',
  'blocked',
  'unblocked',
  'turn_done',
  'error',
  'interrupt',
  'idle_hint',
  'subagent_start',
  'subagent_stop',
  'compact',
  'session_end',
] as const satisfies readonly CanonicalEventType[];

// Time ----------------------------------------------------------------------
export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// Progress lines ------------------------------------------------------------
/** Progress lines kept per session on the server (and shown when expanded). */
export const PROGRESS_KEEP = 10;
/** Progress lines shown on a card / returned by GET /api/state. */
export const PROGRESS_CARD = 4;

// Staleness / ordering / lateness ------------------------------------------
/** working/blocked session with no event for this long is shown as stale (UI). */
export const STALE_MS = 10 * MINUTE_MS;
/** Event ts older than session last_event_at by more than this: progress only, no state change. */
export const OUT_OF_ORDER_GRACE_MS = 5 * SECOND_MS;
/** receivedAt - ts above this marks the session "delayed". */
export const DELAYED_MS = 60 * SECOND_MS;

// Retention -----------------------------------------------------------------
/** events rows are purged after 7 days. */
export const EVENTS_RETENTION_MS = 7 * DAY_MS;
/** Ended sessions (and their progress/events) are purged 24h after ended_at. */
export const ENDED_RETENTION_MS = 24 * HOUR_MS;
/** Default window for ended sessions in GET /api/state (`ended=1h`). */
export const ENDED_VISIBLE_DEFAULT_MS = 1 * HOUR_MS;
/** `ended=` query values accepted by GET /api/state. Anything else -> default (1h). */
export const ENDED_WINDOWS = { '1h': 1 * HOUR_MS, '24h': 24 * HOUR_MS } as const;
export type EndedWindow = keyof typeof ENDED_WINDOWS;
/** Purge runs inside the ingest transaction whenever revision % this === 0. */
export const PURGE_EVERY_REVISIONS = 500;

// Ingest --------------------------------------------------------------------
/** Max envelopes per POST /api/ingest (more -> 413). */
export const INGEST_MAX_BATCH = 100;
/** Max envelopes kept in the local outbox; oldest dropped beyond this. */
export const OUTBOX_MAX = 500;

// Text limits (characters, single line unless noted) ------------------------
/** Session title = first line of the latest prompt. */
export const TITLE_MAX = 120;
/** summarizeTool() output. */
export const SUMMARY_MAX = 120;
/** Full progress line incl. "[agentType] tool: " prefix. */
export const PROGRESS_LINE_MAX = 160;
/** last_message (turn_done text / error text); may be multi-line. */
export const LAST_MESSAGE_MAX = 300;
/** state_msg (blocked reason / question / error). */
export const STATE_MSG_MAX = 300;

// Local reporters -----------------------------------------------------------
/** jfm-emit: at most one PreToolUse per session per this window. */
export const TOOL_THROTTLE_MS = 2 * SECOND_MS;
/** omp extension: retries per envelope after the first attempt. */
export const OMP_RETRIES = 2;
/** omp extension: per-request timeout. */
export const OMP_TIMEOUT_MS = 3 * SECOND_MS;
/** omp extension: max wait for the queue on session_shutdown. */
export const OMP_SHUTDOWN_WAIT_MS = 2 * SECOND_MS;

// Web -----------------------------------------------------------------------
/** Dashboard polling interval. */
export const POLL_INTERVAL_MS = 3 * SECOND_MS;
/** Relative-time re-render tick. */
export const RELATIVE_TICK_MS = 10 * SECOND_MS;
/** localStorage key for the UI language. */
export const LANG_STORAGE_KEY = 'jfm.lang';

// Auth ----------------------------------------------------------------------
/** Read-session cookie name. */
export const COOKIE_NAME = 'jfm_s';
/** Read-session cookie lifetime (30 days). */
export const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
/** Salt mixed with READ_TOKEN to derive the cookie HMAC key. */
export const COOKIE_KEY_SALT = 'jfm-cookie-v1';
/** Delay before answering a failed POST /api/login. */
export const LOGIN_FAIL_DELAY_MS = 300;

// Deployment ----------------------------------------------------------------
/** Durable Object instance name (`env.STORE.idFromName(...)`). */
export const DO_INSTANCE_NAME = 'main';
/** Default local HTTP port for entry.node.ts and the Vite dev proxy target. */
export const DEFAULT_PORT = 8787;
