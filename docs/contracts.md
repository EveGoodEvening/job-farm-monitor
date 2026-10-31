# job-farm-monitor shared contracts

Authoritative cross-package contracts. Types live in
`packages/core/src/types.ts`, constants in `packages/core/src/constants.ts`
(both exported from `@jfm/core`). Spec background: `docs/plan.md`,
tasks: `docs/todo.md`. If this file and the code disagree, fix one of them in
the same change.

## 1. Packages and imports

| Import | Contents | May use |
|---|---|---|
| `@jfm/core` | types, constants, `sessionKey`/`parseSessionKey`, `parseEnvelopes`, `summarizeTool`, `normalize`, `applyEvent`, `SCHEMA_STATEMENTS`, `SCHEMA_MIGRATIONS`, `Store` | web-standard APIs only (Worker + browser safe) |
| `@jfm/core/drivers/node-sqlite` | `nodeSqliteDriver(path)` | `node:sqlite` |
| `@jfm/core/drivers/libsql` | `libsqlDriver(client)` | `@libsql/client` |
| `@jfm/server` | Hono app + 3 entries | - |
| `@jfm/web` | static dashboard | browser |
| `@jfm/local` | shell reporter, hook snippets, omp extension, installer | - |

Workspace consumers resolve `@jfm/core` to source (tsc: `@jfm/source` export
condition; Vite/Vitest: `coreSourceAlias` from `/vitest.shared.ts`; tsup:
esbuild `conditions`, and `@jfm/core` is inlined into the server bundles). The
core `dist/` build is only for completeness.

### Module layout (who exports what)

core (`packages/core/src/`)

| File | Exports |
|---|---|
| `types.ts` | all shared types (see section 3) |
| `constants.ts` | all locked constants (see section 6) |
| `key.ts` | `sessionKey(host, agent, sessionId)`, `parseSessionKey(key)` |
| `envelope.ts` | `parseEnvelopes(body): {envelopes, ignored}`, `parseEnvelope(item)`, `TooManyEnvelopesError` (zod inside) |
| `summarize.ts` | `summarizeTool(agent, toolName, input, cwd?): string` (<= SUMMARY_MAX, single line) |
| `normalize/claude.ts` / `codex.ts` / `omp.ts` | `normalizeClaude` / `normalizeCodex` / `normalizeOmp`: `(payload: unknown) => CanonicalEvent[]` |
| `normalize/common.ts` | hook-payload helpers shared by claude/codex (`readHookPayload`, `subBase`, `originBase`, `text`) |
| `normalize/index.ts` | `normalize(envelope): CanonicalEvent[]` (never throws; unknown -> `[]`) |
| `reducer.ts` | `applyEvent(prev: SessionRow \| null, ev, meta: ReduceMeta): ReduceResult` (pure), `COMPACT_PROGRESS_TEXT` |
| `schema.ts` | `SCHEMA_STATEMENTS: readonly string[]` (one statement each, `IF NOT EXISTS`), `SCHEMA_MIGRATIONS: {version, statements}[]` |
| `store.ts` | `class Store implements StateBackend` - `constructor(driver, {now?})`, `init()`, `ingest(envs, host)`, `state(opts)`, `session(key)`, `purge(now?)`; `StoreOptions`, `REPLACED_END_REASON` (`"replaced"`) |
| `text.ts` | internal string helpers (not public contract) |
| `drivers/sql-driver.ts` | re-exports `SqlDriver`, `SqlExec`, `ExecResult`, `SqlValue` |
| `drivers/node-sqlite.ts` | `nodeSqliteDriver(path: string): SqlDriver` (`name: "node-sqlite"`, `:memory:` ok) |
| `drivers/libsql.ts` | `libsqlDriver(client: Client): SqlDriver` (`name: "libsql"`) |

server (`packages/server/src/`)

| File | Exports |
|---|---|
| `auth.ts` | `parseWriteTokens(raw?: string): Map<token, label>`, `constantTimeEqual(a, b): Promise<boolean>`, `bearerToken(authHeader)`, `findWriteHost(authHeader, tokens): Promise<string \| null>`, `makeReadCookie(readToken, expMs)`, `verifyReadCookie(readToken, value, nowMs?)`, `isReadAuthed(c, readToken)` |
| `backend.ts` | `LocalBackend implements StateBackend` (wraps a `Store`, lazy `init()` once, retried if it failed) |
| `app.ts` | `Runtime`, `RuntimeResolver`, `AppEnv`, `createApp(resolve): Hono`, `LOGIN_BODY_MAX_BYTES`, `INGEST_BODY_MAX_BYTES` |
| `drivers/do-sqlite.ts` | `doSqliteDriver(storage: DurableObjectStorage): SqlDriver` (`name: "do-sqlite"`) |
| `entry.cloudflare.ts` | `export class JfmStore extends DurableObject` (RPC `ingest`/`state`/`session`), `DoBackend`, `export default { fetch }` |
| `entry.node.ts` | Node/Railway server (`@hono/node-server`, `serveStatic` of web dist, SPA fallback) |
| `entry.vercel.ts` | `export default` Hono app on libSQL; `src/index.ts` re-exports it |

Vercel entry: `packages/server/index.js` (Vercel Root Directory =
`packages/server`, Hono preset) imports `hono` and re-exports
`./dist/entry.vercel.js`, the tsup bundle (`npm run build`), because Vercel's
file tracing drops the workspace symlink to `@jfm/core`.

`Runtime = { backend: StateBackend; readToken: string; writeTokens: Map<string,string>; version: string; driverName: string; secureCookies?: boolean }`.

web (`packages/web/src/`): `main.tsx`, `app.tsx`, `api.ts`, `state.ts`,
`group.ts`, `i18n.ts`, `time.ts`, `styles.css`,
`components/{TopBar,Section,SessionCard,Login}.tsx`.
Imports only types + constants from `@jfm/core`.

local: `bin/jfm-emit`, `claude.hooks.json`, `codex.hooks.json`,
`omp/job-farm-monitor.ts`, `install.sh`, `merge-hooks.jq`, `test/*.test.mjs`
(node --test), `test/*.test.ts` (vitest).

## 2. Wire envelope (local reporters -> `POST /api/ingest`)

```json
{ "v": 1, "id": "<unique>", "ts": 1761721234567, "agent": "claude|codex|omp",
  "hostname": "kvm16188", "pid": 12345,
  "env": { "herdr_pane_id": "wS:p1", "herdr_tab_id": "wS:t1", "herdr_workspace_id": "wS", "tmux_pane": "%3" },
  "payload": { } }
```

- `v` literal 1; `id` non-empty string (dedupe key); `ts` integer epoch ms
  (client clock); `agent` enum; `hostname`, `pid`, `env` optional. Empty-string
  env values mean absent. Unknown top-level keys are ignored.
- `payload` for `claude` / `codex`: a minimized projection of hook stdin,
  shaped by `jfm-emit` before enqueue and again before every upload (including
  legacy queued envelopes). The same projection is idempotent:
  - Only explicit session/agent/tool/model/control metadata is kept. String
    identifiers are bounded to 256 chars; cwd and file-tool paths to 2048.
    Model objects keep only `id` / `display_name`.
  - Prompts keep the first nonblank line, <= 120 chars. Reply/error/message/wait
    text is <= 300; tool summaries/previews are <= 120; progress text <= 160.
  - `tool_input` is projected by tool: commands, selected search/description
    fields, file paths, first question, active plan step or explanation.
    `apply_patch` retains at most 64 file-header lines (<= 2048 chars each),
    never diff bodies. Write/Edit contents, arbitrary argument fields, custom
    instructions, transcript paths, permission suggestions and `tool_response`
    are never uploaded. Unknown tools use only recognized preview fields.
  - `JFM_REDACT=1` blanks content fields and `tool_input`, reduces cwd to its
    basename, and retains only metadata/control fields. A session-end reason
    may remain (<= 64 chars); arbitrary error reasons do not. This is content
    suppression, not anonymization of session/host/model/project identifiers.
- `payload` for `omp`: **already canonical** (`OmpPayload`):
  `{ "type": "<canonical event name>", "sessionId": "...", ...that variant's fields }`
  plus optional `hasUI`, `agentId` (session_start: main agent's `ctx.agent.id`;
  subagent_*: the subagent) and `parentId` (T12 fallback). `normalize/omp.ts`
  validates `type` against `CANONICAL_EVENT_TYPES` and the variant's required
  fields and rebuilds a clean event (drops unknown types, `hasUI`, and
  `agentId` except on subagent_*; `parentId` is kept on session_start only).
  The omp extension maps `session_switch` (reason/source `switch`) and
  `session_branch` (`/branch`, `/fork`, `/btw`; `branch`) to `session_end` of
  the old id + `session_start` of the new one. Prompts contain only the first
  nonblank line (<= 120 chars). With `JFM_REDACT=1` it blanks prompt, last
  message, terminal/retry error text (including partial-reply fallbacks),
  question/approval text and tool previews, and sends only cwd's basename.
- Known limitation (omp `parentId` fallback): `parentId` is NOT mapped onto
  the parent session (omp's main agent id is always `Main`, so it cannot
  identify one session); such events create a card under the subagent's own
  session id. The primary path (subagents in the same process, reported on the
  root session id) is unaffected.

## 3. Core types (summary; see `types.ts`)

- `AgentKind = 'claude' | 'codex' | 'omp'`
- `SessionState = 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'ended'`
  (`stale` is computed by the UI: working/blocked and `now - lastEventAt > STALE_MS`;
  `inactive` likewise: idle/done/error and `now - lastEventAt > INACTIVE_MS`,
  shown dimmed and last in its section as "possibly exited". Non-ended sessions
  silent for more than `SILENT_HIDE_MS` are left out of `GET /api/state`.)
- `BlockedKind = 'permission' | 'question'`
- `CanonicalEvent` (discriminated on `type`; every variant has `sessionId`,
  optional `agentType` (progress prefix), optional `agentId` (subagent the
  event came from, Claude/Codex `agent_id`), optional `cwd`):

| type | extra fields |
|---|---|
| `session_start` | `model?`, `source?`, `parentId?` |
| `prompt` | `text` |
| `tool_start` | `tool`, `summary` |
| `progress` | `text` |
| `blocked` | `kind: BlockedKind`, `msg`, `notification?` (generic repeat; ignored while already blocked) |
| `unblocked` | `kind?: BlockedKind` (only clears that kind; PostToolUse of an ordinary tool sends `permission`) |
| `turn_done` | `text` |
| `error` | `text` |
| `interrupt` / `idle_hint` / `compact` | - |
| `subagent_start` / `subagent_stop` | `agentId`, `agentType` (required) |
| `session_end` | `reason?` |

  Normalizers may pass long text; the reducer truncates (title 120, progress
  line 160, last_message 300, state_msg 300). `summary` is already <= 120.
- Hook mapping notes: Claude `PostToolUse` of an ordinary tool (main agent or
  subagent) -> `unblocked(kind: permission, agentId?)`; of a main-agent
  question tool (`AskUserQuestion`, `ExitPlanMode`) -> `unblocked` (no kind).
  `PostToolUseFailure` -> `progress("✗ <tool> failed")` + the same `unblocked`.
  `Notification(permission_prompt | agent_needs_input | elicitation_*dialog)`
  -> `blocked` with `notification: true`. Codex `request_user_input_async`
  PostToolUse emits nothing (the answer is a later prompt).
- `ReduceMeta = { host, agent, ts, receivedAt, env?, hostname? }`;
  `ReduceResult = { session: SessionRow, progressLine?: ProgressLine, changed }`.
  An event for an unknown session implicitly creates it (state idle,
  `started_at = ts`) and is then applied.
- Reducer rules:
  - `at = min(ts, receivedAt)` is used for `last_event_at`, `state_since`,
    `ended_at`, subagent `since` and `ProgressLine.ts` (a fast host clock cannot
    pin lines above newer ones).
  - Out-of-order guard: `ts < last_ts - OUT_OF_ORDER_GRACE_MS` (host clock vs
    host clock) -> only the progress line is recorded. Escape hatch for a clock
    step back: no in-order event for `STALE_MS` and the event is not delayed.
  - `blocked` records `state_agent = agentId ?? null`. `unblocked` and
    `tool_start` clear a block only when their `agentId ?? null` equals
    `state_agent` (and `unblocked.kind`, if set, matches). `tool_start` never
    clears a `question`, nor a block when it comes from a subagent without
    `agentId`. `subagent_stop` clears a block raised by that subagent.
- `SqlDriver = { name; exec(sql, params?) -> Promise<{rows, changes}>; writeTx(fn(exec)) ; close?() }`.
  `?` positional params, values `string | number | null`, one statement per
  call. Store serializes all operations (reads too) with an internal promise
  mutex.

### Database (SQLite, identical on all platforms)

- `meta(k TEXT PRIMARY KEY, v TEXT)`: `revision`, `schema_version`.
- Schema version `SCHEMA_VERSION = 3`. `Store.init()` runs `SCHEMA_STATEMENTS`,
  then every `SCHEMA_MIGRATIONS` entry with `version` > the stored
  `schema_version` (none for a fresh DB), then stores `SCHEMA_VERSION`.
  Migration 2: `ADD COLUMN last_ts INTEGER NOT NULL DEFAULT 0`,
  `ADD COLUMN state_agent TEXT`. Migration 3: `ALTER TABLE events DROP COLUMN
  raw_json`, preserving event IDs, indexes and dashboard state. This removes
  logical payload access; it does not scrub backups or guarantee forensic erasure.
- `sessions` columns = `SessionRow` fields: `key` PK (`host/agent/session_id`),
  `host, agent, session_id, cwd, project, title, model, state, state_kind,
  state_msg, state_since, last_event_at, started_at, ended_at, last_message,
  subagents_json ('{}' default; {agentId: {type, since}}), herdr_pane_id,
  herdr_tab_id, herdr_workspace_id, tmux_pane, hostname, delayed (0/1),
  last_ts, state_agent`. Internal (not in `SessionView`):
  - `tmux_pane`: with `herdr_pane_id` it identifies the pane for Codex reaping
    (section 4, Store semantics).
  - `last_ts`: client-clock ts of the latest in-order event (out-of-order
    reference; 0 for rows migrated from v1).
  - `state_agent`: while blocked, the subagent `agentId` that raised it
    (`null` = main agent).
- `progress(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_key, ts, text, agent_type)`,
  newest `PROGRESS_KEEP` per session kept.
- `events(id TEXT PRIMARY KEY, session_key, ts, received_at, type)` stores only
  deduplication/retention metadata, never raw or canonical payloads;
  `INSERT OR IGNORE` with `changes === 0` = duplicate. Session/progress tables
  retain their bounded display text and metadata.

## 4. HTTP API

All responses JSON unless stated. Error body: `{ "error": "<code>" }` with codes
`unauthorized`, `bad_request`, `not_found`, `too_large`, `internal` (500 for any
unhandled error, logged server-side). `/api/*` responses carry
`Cache-Control: no-store`. No CORS. Static files are public; everything under
`/api/*` except `health`, `login`, `logout` requires auth.

| Method + path | Auth | Request | Responses |
|---|---|---|---|
| `GET /api/health` | none | - | 200 `{ "ok": true, "version": "0.1.0", "driver": "do-sqlite\|node-sqlite\|libsql" }` |
| `POST /api/login` | none | `{ "token": "<READ_TOKEN>" }` (<= `LOGIN_BODY_MAX_BYTES` = 4 KiB) | 204 + `Set-Cookie: jfm_s=<expMs>.<base64url(hmac)>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000[; Secure]`; 401 after a 300 ms delay on a wrong token; 400 on a malformed body; 413 body too large |
| `POST /api/logout` | none | - | 204 + `Set-Cookie: jfm_s=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax[; Secure]` |
| `GET /api/me` | read | - | 204 / 401 |
| `GET /api/state?since=<rev>&ended=1h\|24h` | read | - | 200 `StateResponse`; 304 (empty body) when unchanged since `since` (see below); 401 |
| `GET /api/sessions/:key` | read | `:key` = `encodeURIComponent(session.key)` | 200 `SessionView` (<= 10 progress lines); 404; 401 |
| `POST /api/ingest` | write | `Envelope` or `Envelope[]` (<= 100, body <= `INGEST_BODY_MAX_BYTES` = 4 MiB) | 200 `IngestResult`; 400 invalid JSON; 401 bad/missing write token; 413 more than 100 envelopes or body too large |
| any other `/api/*` | - | - | 404 `{ "error": "not_found" }` |

- **Body caps** (`hono/body-limit`): enforced from `Content-Length` or while a
  chunked body streams. Ingest checks write auth first, so unauthenticated
  callers never get a body read.
- **Read auth**: cookie `jfm_s` (HMAC-SHA256 via Web Crypto, key derived from
  `READ_TOKEN` + salt `jfm-cookie-v1`, value `<expiry epoch ms>.<base64url mac>`,
  30 days) **or** `Authorization: Bearer <READ_TOKEN>`. Changing `READ_TOKEN`
  logs everyone out; an empty `READ_TOKEN` disables login. `Secure` is added
  when the request URL is https or `X-Forwarded-Proto` (first value) is
  `https`, unless `Runtime.secureCookies` overrides it.
- **Write auth**: `Authorization: Bearer <token>`; `WRITE_TOKENS="label:token,label2:token2"`.
  The host label comes from the matching token (constant-time compare);
  `envelope.hostname` is informational only.
- `since`: non-negative integer (<= 15 digits); missing/invalid -> full
  snapshot. `ended`: `1h` (default) or `24h` (`ENDED_WINDOWS`); other values ->
  `1h`. The server calls `backend.state({ since, endedWithinMs, progressLimit: PROGRESS_CARD })`
  (`silentWithinMs` defaults to `SILENT_HIDE_MS`).
- **Silent sessions**: a non-ended session with no event for more than
  `SILENT_HIDE_MS` (24 h; its agent most likely died without a `session_end`:
  `kill -9`, interactive Codex `/exit`, a lost omp shutdown POST) is left out
  of the snapshot. The row is not modified or ended; its next event makes it
  visible again. The dashboard re-applies the same rule on every render.
- **304 and window aging**: `backend.state` returns `null` whenever `since`
  equals the revision, but the ended window and the silent cutoff move with the
  clock. Before answering 304 the app reads all rows (`endedWithinMs` and
  `silentWithinMs` = `MAX_SAFE_INTEGER`, `progressLimit: 0`); with `L` = newest
  `lastEventAt`/`endedAt`, if some ended session has `endedAt` in
  `(L - window, now - window]`, or some non-ended session has `lastEventAt` in
  `(L - SILENT_HIDE_MS, now - SILENT_HIDE_MS]`, it may have aged out of the
  client's snapshot, so it answers 200 with a full snapshot instead (also if
  the revision moved meanwhile). Never a wrong 304; at worst a 200 until the
  revision next changes.
- Ingest: the server rejects arrays longer than `INGEST_MAX_BATCH` with 413
  before parsing, runs `parseEnvelopes`, calls `backend.ingest(valid, host)` and
  returns `{ accepted, ignored: parseIgnored + backend.ignored, revision }`.
  Invalid items never fail the request (poison-pill safety). `[]` is valid
  (used by `jfm-emit --check`) and returns the current revision.
- `GET /api/sessions/:key`: Hono already percent-decodes route params; do not
  decode twice. Keys contain `/`, so clients must use `encodeURIComponent`
  (the route `:key{.+}` also tolerates raw slashes).

### JSON shapes

```ts
StateResponse = { revision: number; now: number; sessions: SessionView[] } // sorted lastEventAt desc
IngestResult  = { accepted: number; ignored: number; revision: number }
SessionView = {
  key, host, agent, sessionId, cwd, project, title, model,
  state, stateKind, stateMsg, stateSince, lastEventAt, startedAt, endedAt,
  lastMessage, subagents: { id, type, since }[],
  herdrPaneId, herdrTabId, herdrWorkspaceId, hostname,
  delayed: boolean,
  progress: { ts, text, agentType }[]   // newest first
}
```

Nullable string fields are `null` (never `undefined`) so DO RPC, JSON and
tests agree. Timestamps are epoch ms numbers.

### Store semantics (shared by all backends)

- `ingest`: per envelope `INSERT OR IGNORE` into `events` (duplicate ->
  `ignored`), `normalize`, `applyEvent` per canonical event, upsert session,
  insert progress line and trim to 10. If anything changed, `revision += 1`
  (once per ingest call). When the new revision is a multiple of
  `PURGE_EVERY_REVISIONS`, `purge` runs in the same transaction.
- Codex pane reaping (interactive Codex never sends SessionEnd): a Codex
  `session_start` with `source` `startup` or `clear` and a pane id
  (`herdr_pane_id` preferred, else `tmux_pane`) ends every other non-ended
  Codex session of the same host on that pane that started no later than it,
  with `session_end(reason: "replaced")`. `clear` always replaces; `startup`
  (also sent by nested/parallel `codex exec`) replaces only a session at rest
  (idle/done/error) or silent for more than `STALE_MS`.
- `state(opts)`: `opts.since === revision` -> `null` (304, see the app's
  window check above). Otherwise non-ended sessions with
  `last_event_at > now - silentWithinMs` (default `SILENT_HIDE_MS`) plus ended
  sessions with `ended_at > now - endedWithinMs`, each with `progressLimit`
  newest progress lines. Rows are never changed by this filter.
- `session(key)`: full view with `PROGRESS_KEEP` lines, or `null`.
- `purge(now)`: delete events with `received_at < now - 7d`; sessions with
  `ended_at < now - 24h` and their progress/events. Automatic purge is triggered
  every 500 changed ingest revisions, not by reads or a wall-clock timer.

## 5. Platforms and environment

| Var | Used by | Meaning |
|---|---|---|
| `READ_TOKEN` | all | dashboard/read token |
| `WRITE_TOKENS` | all | `label:token,...` |
| `JFM_DB_PATH` | node | SQLite file; default `${RAILWAY_VOLUME_MOUNT_PATH:-./data}/jfm.sqlite` |
| `PORT` | node | default 8787 locally, 8080 in Docker |
| `HOST` | node | listen address; default all interfaces (set `127.0.0.1` for local dev) |
| `JFM_WEB_DIST` | node, vercel | override the dashboard directory (node: `packages/web/dist`, vercel: `packages/server/public`) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | vercel | libSQL; `file:./dev.db` locally |

- Cloudflare: `wrangler.jsonc` binding `STORE` -> class `JfmStore`
  (`new_sqlite_classes`), instance `idFromName(DO_INSTANCE_NAME = "main")`,
  assets `../web/dist` with `run_worker_first: ["/api/*"]`.
- Vercel: Root Directory `packages/server`, entry `index.js` (section 1); the
  build copies `packages/web/dist` to `packages/server/public`, which ships with
  the function (`includeFiles`) and is served by it (`src/static.ts`), not by
  the CDN.
- Dev ports: node entry and `wrangler dev` both on 8787; Vite proxies `/api`
  to `http://127.0.0.1:8787`.

### Local reporter config

`~/.config/job-farm-monitor/config` (0600, sh `KEY=value` lines, parsed not
sourced; env vars win): `JFM_ENDPOINT` (base origin, e.g.
`https://jfm.example.workers.dev`; reporters POST to
`${JFM_ENDPOINT}/api/ingest`), `JFM_WRITE_TOKEN`, `JFM_DISABLE=1`,
`JFM_REDACT=1`, `JFM_RECORD_DIR`. State:
`~/.local/state/job-farm-monitor/{outbox,markers,lock.d,record,rejected}`, log
`emit.log`.

`JFM_DISABLE=1` prevents shell collection and flushing: queued events and cleanup
state remain untouched, with no network request. Re-enabling can send the queue.
The explicit `--check` diagnostic still contacts the endpoint. Config is read
once per shell invocation / OMP factory initialization, not hot-reloaded;
already-running flushes and in-flight requests are not cancelled. Restart OMP
after a config change. Reinstall reporters and redeploy the server for upgrades.

`--record` / `JFM_RECORD_DIR` explicitly retains raw local stdin even with
redaction enabled. Existing outbox/rejected files, recordings and backups are
not scrubbed: queued payloads are sanitized in outbound batches, not rewritten
on disk. Marker fingerprints below also retain local input fragments.

`jfm-emit` markers (`markers/`, files older than 24 h are removed on flush):

- `<sid>.tool`: last PreToolUse ts (throttle, `TOOL_THROTTLE_MS` per session).
- `<sid>@<agentKey>.blocked`, `agentKey` = `main` or `a-<agent_id>`
  (subagents share the parent's session id): holds the fingerprint of the
  waiting call (tool name + start of the canonicalized `tool_input`), or `*`
  for an unknown call (from a Notification). Only a PostToolUse with the same
  fingerprint (or `*`), or a question tool, clears it; other PostToolUse events
  are not sent. PostToolUseFailure is always sent. A main-agent
  UserPromptSubmit/Stop/Interrupt removes all of the session's blocked
  markers; SessionEnd also removes the tool marker.

Batches are <= 100 envelopes and <= 1 MB; a lone envelope rejected with
400/413/414/415/422 (or failing alone 3 times while others succeed) is moved
to `rejected/` (kept 7 days).

## 6. Constants (`constants.ts`)

| Name | Value |
|---|---|
| `PROGRESS_KEEP` / `PROGRESS_CARD` | 10 / 4 |
| `STALE_MS` | 10 min |
| `INACTIVE_MS` | 6 h (UI: idle/done/error shown as "possibly exited") |
| `SILENT_HIDE_MS` | 24 h (non-ended sessions left out of `GET /api/state`) |
| `OUT_OF_ORDER_GRACE_MS` | 5 s |
| `DELAYED_MS` | 60 s |
| `EVENTS_RETENTION_MS` | 7 days |
| `ENDED_RETENTION_MS` | 24 h |
| `ENDED_VISIBLE_DEFAULT_MS`, `ENDED_WINDOWS` | 1 h; `{ '1h': 1h, '24h': 24h }` |
| `PURGE_EVERY_REVISIONS` | 500 |
| `INGEST_MAX_BATCH` / `OUTBOX_MAX` | 100 / 500 |
| `TITLE_MAX` / `SUMMARY_MAX` / `PROGRESS_LINE_MAX` | 120 / 120 / 160 |
| `LAST_MESSAGE_MAX` / `STATE_MSG_MAX` | 300 / 300 |
| `TOOL_THROTTLE_MS` | 2 s |
| `OMP_RETRIES` / `OMP_TIMEOUT_MS` / `OMP_SHUTDOWN_WAIT_MS` | 2 / 3 s / 2 s |
| `POLL_INTERVAL_MS` / `RELATIVE_TICK_MS` | 3 s / 10 s |
| `LANG_STORAGE_KEY` | `jfm.lang` |
| `THEME_STORAGE_KEY` | `jfm.theme` (`light` / `dark`; absent = system) |
| `COOKIE_NAME` / `COOKIE_MAX_AGE_S` / `COOKIE_KEY_SALT` | `jfm_s` / 2592000 / `jfm-cookie-v1` |
| `LOGIN_FAIL_DELAY_MS` | 300 |
| `DO_INSTANCE_NAME` / `DEFAULT_PORT` | `main` / 8787 |
| `APP_VERSION` / `SCHEMA_VERSION` | `0.1.0` / 3 |

Server-only (`packages/server/src/app.ts`): `LOGIN_BODY_MAX_BYTES` = 4 KiB,
`INGEST_BODY_MAX_BYTES` = 4 MiB.
