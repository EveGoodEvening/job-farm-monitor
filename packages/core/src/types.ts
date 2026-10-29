// Shared contracts for every job-farm-mon package.
//
// This file is the single source of truth for shapes that cross package
// boundaries (core <-> server <-> web <-> local). It must stay free of runtime
// code and of any platform import (no `node:*`, no `@libsql/client`) because
// the Cloudflare Worker and the browser bundle import it through `@jfm/core`.
// See docs/contracts.md for the prose version.

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The coding agents we ingest from. */
export type AgentKind = 'claude' | 'codex' | 'omp';

/**
 * Server-side session state. `stale` is NOT a state: the web UI derives it from
 * `lastEventAt` (see STALE_MS). Aligned with herdr / OSC 7501 vocabulary.
 */
export type SessionState = 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'ended';

/** Sub-kind of `blocked`. Stored in `sessions.state_kind`. */
export type BlockedKind = 'permission' | 'question';

// ---------------------------------------------------------------------------
// Wire envelope (jfm-emit and the omp extension -> POST /api/ingest)
// ---------------------------------------------------------------------------

/**
 * Terminal/multiplexer ids captured from the agent's environment. Senders may
 * omit a key or send an empty string; both mean "absent" (store NULL).
 */
export interface EnvelopeEnv {
  herdr_pane_id?: string;
  herdr_tab_id?: string;
  herdr_workspace_id?: string;
  tmux_pane?: string;
}

/**
 * One reported hook event. `POST /api/ingest` accepts one Envelope or an array
 * of at most INGEST_MAX_BATCH. `id` is globally unique and used for dedupe.
 *
 * `payload`:
 * - agent "claude" / "codex": the hook's raw stdin JSON object
 *   (`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, ...),
 *   possibly with text fields blanked when JFM_REDACT=1.
 * - agent "omp": an already-canonical object, see {@link OmpPayload}.
 */
export interface Envelope {
  v: 1;
  id: string;
  /** Client clock, epoch milliseconds (integer). */
  ts: number;
  agent: AgentKind;
  /** Informational only; the host label comes from the write token. */
  hostname?: string;
  pid?: number;
  env?: EnvelopeEnv;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Canonical events (output of normalize(), input of the reducer)
// ---------------------------------------------------------------------------

/** Fields shared by every canonical event. */
export interface CanonicalEventBase {
  /** Agent session id (NOT the composite session key). */
  sessionId: string;
  /**
   * Set when the event originated inside a subagent; used as the `[agentType]`
   * prefix of progress lines. For subagent_* events it is the subagent type.
   */
  agentType?: string;
  /**
   * Id of the subagent the event originated in, when the source reports one
   * (Claude/Codex `agent_id`). The reducer uses it to let only the agent that
   * raised a blocked state clear it. For subagent_* events: the subagent.
   */
  agentId?: string;
  /** Working directory if the source event carried one. */
  cwd?: string;
}

export interface SessionStartEvent extends CanonicalEventBase {
  type: 'session_start';
  model?: string;
  /** Claude: startup|resume|clear|compact; omp: start|switch; Codex: as reported. */
  source?: string;
  /** omp fallback (T12): parent agent id when a subagent runs in its own process. */
  parentId?: string;
}

export interface PromptEvent extends CanonicalEventBase {
  type: 'prompt';
  /** Prompt text (may be long/multi-line; the reducer derives the title). */
  text: string;
}

export interface ToolStartEvent extends CanonicalEventBase {
  type: 'tool_start';
  /** Tool name as reported by the agent (e.g. "Bash", "exec_command", "retry"). */
  tool: string;
  /** Output of summarizeTool(), single line, <= SUMMARY_MAX chars. */
  summary: string;
}

/** A progress line that does not change state (e.g. "✗ Bash failed"). */
export interface ProgressEvent extends CanonicalEventBase {
  type: 'progress';
  text: string;
}

export interface BlockedEvent extends CanonicalEventBase {
  type: 'blocked';
  kind: BlockedKind;
  /** Why it waits: permission request summary or question text. */
  msg: string;
  /**
   * Derived from a generic notification (Claude `Notification`) that repeats
   * an already-reported prompt with less detail: ignored while the session is
   * already blocked (plan: "Notification permission_prompt（去重）").
   */
  notification?: boolean;
}

export interface UnblockedEvent extends CanonicalEventBase {
  type: 'unblocked';
  /**
   * When set, only a blocked state of this kind is cleared. Hook agents send
   * `kind: "permission"` for the PostToolUse of an ordinary tool, so it cannot
   * clear a pending (e.g. Codex async) question; question-tool PostToolUse and
   * omp send no kind (clears either).
   */
  kind?: BlockedKind;
}

export interface TurnDoneEvent extends CanonicalEventBase {
  type: 'turn_done';
  /** Last assistant message (reducer truncates to LAST_MESSAGE_MAX). */
  text: string;
}

export interface ErrorEvent extends CanonicalEventBase {
  type: 'error';
  text: string;
}

export interface InterruptEvent extends CanonicalEventBase {
  type: 'interrupt';
}

/** Claude `Notification(idle_prompt)`: working -> done if Stop was lost. */
export interface IdleHintEvent extends CanonicalEventBase {
  type: 'idle_hint';
}

export interface SubagentStartEvent extends CanonicalEventBase {
  type: 'subagent_start';
  agentId: string;
  agentType: string;
}

export interface SubagentStopEvent extends CanonicalEventBase {
  type: 'subagent_stop';
  agentId: string;
  agentType: string;
}

export interface CompactEvent extends CanonicalEventBase {
  type: 'compact';
}

export interface SessionEndEvent extends CanonicalEventBase {
  type: 'session_end';
  reason?: string;
}

export type CanonicalEvent =
  | SessionStartEvent
  | PromptEvent
  | ToolStartEvent
  | ProgressEvent
  | BlockedEvent
  | UnblockedEvent
  | TurnDoneEvent
  | ErrorEvent
  | InterruptEvent
  | IdleHintEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | CompactEvent
  | SessionEndEvent;

export type CanonicalEventType = CanonicalEvent['type'];

/**
 * `Envelope.payload` when `agent === "omp"`. The omp extension already emits
 * canonical events, so normalize/omp.ts validates and passes through:
 * `{ type: <canonical event name>, sessionId, ...that variant's fields }`.
 * Extra optional fields the extension may add:
 * - `hasUI`   (session_start) informational.
 * - `agentId` (session_start) the omp `ctx.agent.id` of the main agent.
 * - `parentId` (T12 fallback) parent agent id for subagent events sent from
 *   a separate process. Known limitation: NOT mapped onto the parent session
 *   (omp's main agent id is always "Main", so it cannot identify a session);
 *   such events create a card under the subagent's own session id.
 */
export type OmpPayload = CanonicalEvent & {
  hasUI?: boolean;
  agentId?: string;
  parentId?: string;
};

// ---------------------------------------------------------------------------
// Database rows (snake_case, mirrors the SQLite schema)
// ---------------------------------------------------------------------------

/** `{ [agentId]: { type, since } }`, serialized into sessions.subagents_json. */
export type SubagentMap = Record<string, { type: string; since: number }>;

/** One row of `sessions`. `key = host + "/" + agent + "/" + session_id`. */
export interface SessionRow {
  key: string;
  host: string;
  agent: AgentKind;
  session_id: string;
  cwd: string | null;
  /** basename(cwd) */
  project: string | null;
  /** First line of the latest prompt, <= TITLE_MAX chars. */
  title: string | null;
  model: string | null;
  state: SessionState;
  /** Only set while state === "blocked". */
  state_kind: BlockedKind | null;
  /** blocked: reason/question; error: error text. <= STATE_MSG_MAX chars. */
  state_msg: string | null;
  /** epoch ms; updated only when `state` (or state_kind) changes. */
  state_since: number;
  /** epoch ms; min(event ts, receivedAt) of the latest in-order event. */
  last_event_at: number;
  started_at: number;
  ended_at: number | null;
  /** Last assistant message (turn_done) or error text, <= LAST_MESSAGE_MAX. */
  last_message: string | null;
  /** JSON of SubagentMap; "{}" when none. */
  subagents_json: string;
  herdr_pane_id: string | null;
  herdr_tab_id: string | null;
  herdr_workspace_id: string | null;
  /** Envelope env.tmux_pane (used with herdr_pane_id to detect a replaced Codex session). */
  tmux_pane: string | null;
  /** Envelope hostname (informational; `host` is the trusted label). */
  hostname: string | null;
  /** 1 when the latest event arrived > DELAYED_MS after its ts, else 0. */
  delayed: 0 | 1;
  /**
   * Client-clock ts (envelope ts) of the latest in-order event; the
   * out-of-order guard compares against this, not the clamped last_event_at.
   * 0 for rows migrated from schema v1.
   */
  last_ts: number;
  /** While blocked: agentId of the subagent that raised it (null = main agent). */
  state_agent: string | null;
}

/** One row of `progress` (newest PROGRESS_KEEP kept per session). */
export interface ProgressRow {
  seq?: number;
  session_key: string;
  ts: number;
  text: string;
  agent_type: string | null;
}

/** Metadata-only deduplication row (kept EVENTS_RETENTION_MS). */
export interface EventRow {
  id: string;
  session_key: string | null;
  ts: number;
  received_at: number;
  type: string;
}

// ---------------------------------------------------------------------------
// Reducer contract
// ---------------------------------------------------------------------------

/** Progress line produced by the reducer / returned in views (camelCase). */
export interface ProgressLine {
  ts: number;
  /** Already formatted, e.g. "[Explore] Bash: npm test", <= PROGRESS_LINE_MAX. */
  text: string;
  agentType: string | null;
}

/** Context the reducer needs besides the event itself. */
export interface ReduceMeta {
  host: string;
  agent: AgentKind;
  /** Envelope ts (client clock). */
  ts: number;
  /** Server receive time. */
  receivedAt: number;
  env?: EnvelopeEnv;
  hostname?: string;
}

export interface ReduceResult {
  /** Always non-null: an event for an unknown session implicitly creates it. */
  session: SessionRow;
  progressLine?: ProgressLine;
  /** True when anything in the row changed or a progress line was produced. */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// API view types (camelCase JSON returned by the HTTP API)
// ---------------------------------------------------------------------------

export interface SubagentView {
  id: string;
  type: string;
  since: number;
}

export interface SessionView {
  key: string;
  host: string;
  agent: AgentKind;
  sessionId: string;
  cwd: string | null;
  project: string | null;
  title: string | null;
  model: string | null;
  state: SessionState;
  stateKind: BlockedKind | null;
  stateMsg: string | null;
  stateSince: number;
  lastEventAt: number;
  startedAt: number;
  endedAt: number | null;
  lastMessage: string | null;
  subagents: SubagentView[];
  herdrPaneId: string | null;
  herdrTabId: string | null;
  herdrWorkspaceId: string | null;
  hostname: string | null;
  delayed: boolean;
  /** Newest first. /api/state: <= PROGRESS_CARD; /api/sessions/:key: <= PROGRESS_KEEP. */
  progress: ProgressLine[];
}

/** 200 body of GET /api/state. */
export interface StateResponse {
  revision: number;
  /** Server clock (epoch ms) for client skew correction. */
  now: number;
  /** Sorted by lastEventAt descending. */
  sessions: SessionView[];
}

/** 200 body of POST /api/ingest. */
export interface IngestResult {
  /** Envelopes newly stored. */
  accepted: number;
  /** Duplicates (already-seen id) + envelopes rejected by validation. */
  ignored: number;
  /** Revision after this ingest. */
  revision: number;
}

export interface StateOptions {
  /** Client's last revision; if equal to the current revision -> null (304). */
  since?: number;
  /** Ended sessions are included only if ended_at > now - endedWithinMs. */
  endedWithinMs: number;
  /** Newest progress lines per session to include. */
  progressLimit: number;
}

/**
 * What the Hono app talks to. Implemented by Store (Node/Vercel, directly or
 * via server's LocalBackend) and by DoBackend (Cloudflare DO RPC stub).
 */
export interface StateBackend {
  ingest(envelopes: Envelope[], host: string): Promise<IngestResult>;
  /** null means "unchanged since opts.since" (HTTP 304). */
  state(opts: StateOptions): Promise<StateResponse | null>;
  /** Full view with up to PROGRESS_KEEP progress lines; null if unknown key. */
  session(key: string): Promise<SessionView | null>;
}

// ---------------------------------------------------------------------------
// SQL driver abstraction
// ---------------------------------------------------------------------------

/** Positional (`?`) parameter values. Integers are passed as JS numbers. */
export type SqlValue = string | number | null;

export interface ExecResult {
  rows: Record<string, unknown>[];
  /** Rows written/changed by the statement (0 for reads). */
  changes: number;
}

export type SqlExec = (sql: string, params?: readonly SqlValue[]) => Promise<ExecResult>;

/**
 * Thin SQLite driver. Implementations: node-sqlite (core), libsql (core),
 * do-sqlite (server, Cloudflare DO). One statement per exec() call.
 */
export interface SqlDriver {
  /** "node-sqlite" | "libsql" | "do-sqlite"; reported by /api/health. */
  readonly name: string;
  exec: SqlExec;
  /**
   * Run `fn` inside a write transaction; commit on resolve, roll back and
   * rethrow on reject. Callers (Store) serialize writeTx calls themselves.
   */
  writeTx<T>(fn: (exec: SqlExec) => Promise<T>): Promise<T>;
  close?(): Promise<void> | void;
}
