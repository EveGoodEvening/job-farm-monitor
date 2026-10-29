# AGENTS.md

job-farm-monitor is a remote dashboard showing, at a glance, what every coding agent
(Claude Code, Codex CLI, oh-my-pi) on several machines is doing: working,
waiting for permission, waiting for an answer, done, error or ended. Agents
report through their own hooks/extensions to a self-hosted API; one code base
deploys to Cloudflare Workers (Durable Object SQLite), Railway (Node 24 +
`node:sqlite`) and Vercel (Turso / libSQL).

- Spec: `docs/plan.md` (Chinese). Task tracker: `docs/todo.md` (Chinese).
- Shared contracts (types, HTTP API, module layout): `docs/contracts.md` and
  `packages/core/src/types.ts`. Code against these; change them deliberately.

## Directory map

| Path | Package | What lives there |
|---|---|---|
| `packages/core` | `@jfm/core` | Pure TS: `types.ts`, `constants.ts`, `key.ts`, `envelope.ts` (zod), `summarize.ts`, `normalize/{claude,codex,omp,index}.ts`, `reducer.ts`, `schema.ts`, `store.ts`. Subpath exports `./drivers/node-sqlite` and `./drivers/libsql` keep Node/libSQL out of the Worker bundle. |
| `packages/server` | `@jfm/server` | Hono app (`app.ts`, `auth.ts`, `backend.ts`), entries `entry.cloudflare.ts` (Worker + `JfmStore` DO), `entry.node.ts` (Railway), `entry.vercel.ts`; `drivers/do-sqlite.ts`; `wrangler.jsonc`, `vercel.json`, `tsup.config.ts`. |
| `packages/web` | `@jfm/web` | Vite 8 + Preact 11 + @preact/signals dashboard, built to `packages/web/dist` and served by all three platforms. |
| `local` | `@jfm/local` | `bin/jfm-emit` (POSIX sh + jq + curl reporter), `claude.hooks.json`, `codex.hooks.json`, `omp/job-farm-monitor.ts` (oh-my-pi extension), `install.sh`, `merge-hooks.jq`, tests. |
| `scripts` | - | Dev helpers (`seed.mjs`, screenshot script). |
| `Dockerfile`, `railway.json` | - | Railway image (repo root). |

## Commands

```sh
npm ci                      # reproducible install for all workspaces
npm run build               # core -> server -> web
npm run typecheck           # all workspaces (core also runs a "pure" check without Node types)
npm run lint                # eslint flat config (typescript-eslint recommended)
npm test                    # vitest (+ node --test in local); no workerd
npm run test:workers        # server Worker tests in workerd: HEAVY, use heavy-gate (below)
npm run dev:node | dev:web | dev:cf
```

## Conventions

- Node 24.22.1 locally (`.nvmrc`), security floor `>=24.22.1 <25`; npm 12.2.1.
  TypeScript 5.9.x (not 7.x), ESM everywhere. Relative imports in core/server
  use `.js` extensions (NodeNext). Web uses bundler resolution.
- Exact dependency pins (no `^`). Keep versions in sync with `docs/todo.md`
  "Locked decisions" unless a Lesson below says otherwise.
- `@jfm/core` "." must never import `node:*` or `@libsql/client`
  (`tsconfig.pure.json` enforces this during typecheck).
- Workspace consumers resolve `@jfm/core` to TypeScript source: tsc via the
  `@jfm/source` export condition (`customConditions` in `tsconfig.base.json`),
  Vite/Vitest via `coreSourceAlias` from `vitest.shared.ts`, tsup via esbuild
  `conditions`. No core build is needed before typecheck/test.
- Constants come from `@jfm/core` (`constants.ts`); do not re-type numbers.
- Never touch the real agent configs (`~/.claude/settings.json`,
  `~/.codex/hooks.json`, `~/.codex/config.toml`, `~/.omp/**`) in tests; use a
  temporary `HOME`.
- Secrets (`READ_TOKEN`, `WRITE_TOKENS`, `TURSO_AUTH_TOKEN`, local config
  `~/.config/job-farm-monitor/config`) never go in the repo, logs or responses.
- Commit only when the user asks; commit messages carry no AI attribution lines.

## Testing and heavy-gate

Memory is shared machine-wide. Anything heavy runs through the gate, in the
background:

```sh
~/.claude/bin/heavy-gate -n 1 -l jfm-workers -- npm run test:workers   # workerd
~/.claude/bin/heavy-gate -n 1 -l jfm-shot -- node scripts/screenshot.mjs  # browser
```

- Browsers: one at a time, Playwright `--workers=1`, closed in `finally`.
- `wrangler dev`, `docker build`, `vercel build` also go through the gate.
- The PreToolUse hook cannot see through nested npm scripts (`npm run typecheck`
  at the root nests per-workspace scripts); run such root scripts via the gate
  or invoke the per-package command directly (e.g. `npx tsc -p packages/core`).

## Lessons

### Toolchain and versions

- `@cloudflare/vitest-pool-workers` 0.23.0 only accepts vitest ^4.1 and is deprecated. Use `@cloudflare/vitest-plugin` 1.4.10 instead: it accepts vitest 5.0.5 and pins wrangler 4.155.0. Config: `plugins: [cloudflareTest({ wrangler: { configPath } })]`. Tests import `SELF`/`env`/`runInDurableObject` from `cloudflare:test`.
- npm 12 blocks dependency install scripts unless they are allow-listed. Run `npm install-scripts approve esbuild workerd`, and approve again whenever the lockfile changes those versions.
- The heavy-gate hook refuses root `npm run build|test|typecheck`, because they fan out to workspaces. Run them as `~/.claude/bin/heavy-gate -n 1 -l <label> -- <cmd>`. `env -i` and `timeout` go inside the gate's `bash -c`.
- `@jfm/core` is consumed from source through the custom export condition `@jfm/source` (tsc `customConditions`, `coreSourceAlias` in `vitest.shared.ts`, tsup/esbuild `conditions`). Core's `"."` entry must stay Node-free: `tsconfig.pure.json` with `noUncheckedSideEffectImports` enforces it.
- The web bundle may import only constants from `@jfm/core` at runtime. `vite.config.ts` aliases it to `constants.ts`, because the index pulls in zod (+25 KB gzip).
- tsup 8.5 strips the `node:` prefix by default, which breaks `node:sqlite`. Set `removeNodeProtocol: false`.
- node:sqlite rows have a null prototype, so spread them. libsql rows are array-like, so build plain objects from `rs.columns`.

### Platform investigations (T42/T44)

- wrangler 4.155.0 accepts `assets.run_worker_first: ["/api/*"]`. `wrangler deploy --dry-run --outdir` validates config without logging in. With `--var KEY:VALUE`, the split happens at the first colon only.
- In DO SQLite, `ctx.storage.transaction()` rolls back `storage.sql.exec` writes when the closure throws. `cursor.rowsWritten` is 0 when `INSERT OR IGNORE` hits a duplicate.
- Vercel's Hono preset picks its entry from the first of app/index/server/src/app/src/index/src/server whose text imports `hono`. It also drops the workspace symlink `@jfm/core` from traced functions. So the Vercel entry is a root `packages/server/index.js` (`import 'hono'`) that re-exports the tsup bundle `dist/entry.vercel.js` with core inlined. Never run `vercel build` in the real repo, because its installCommand `npm ci` wipes node_modules.
- `npx vercel build` works offline without login as long as `.vercel/project.json` exists.
- Behind a TLS proxy (Railway/Vercel), Node sees http requests, so the Secure-cookie check must also honor `X-Forwarded-Proto`.
- Railway rejects the Dockerfile `VOLUME` instruction, so mount the volume at /data via the Railway UI.

### Agent hook facts (T10/T11/T12)

- Claude 2.1.312: SessionStart has `model` only on interactive startup. AskUserQuestion fires PreToolUse → PermissionRequest(tool_name=AskUserQuestion) → Notification permission_prompt. That sequence must not overwrite blocked/question with blocked/permission. A SubagentStop with empty `agent_type` and no matching start can follow Stop. Only `agent_id` marks a subagent event; `agent_type` alone also appears with `--agent`.
- Codex 0.165.0 (T11): subagent tool hooks carry both `agent_id` and `agent_type`, plus the parent `session_id`. No SessionStart fires for a subagent. `agent_type` is usually `"default"`, so in that case the prefix falls back to the first 8 chars of `agent_id`.
- Codex trust: the hash covers the command string, so changing it drops trust silently, in `codex exec` too. Hook timeouts for SessionEnd/Interrupt are capped at 3s. Interactive sessions do not fire SessionEnd on /exit or /clear; it fires only when the app-server daemon stops.
- Codex tool names: `request_user_input_async` is the question tool in default mode. Its PostToolUse fires immediately, and the answer arrives as a UserPromptSubmit starting with `<send_user_message_question_reply>`. Other tool names are glued to their namespace (`collaborationspawn_agent`), and the shell tool is `Bash`.
- oh-my-pi 18.13.3 (T12): subagents run in the same process. Isolated or worktree tasks and `/reload` re-import the extension with a cache-buster, so shared root state lives on `globalThis[Symbol.for(...)]`, not in module variables. Sub sessions also fire session_start/session_shutdown with `kind: "sub"`. session_shutdown handlers are capped at 2 s.
- Capturing hooks without touching user config:
  - Claude: `claude -p ... --setting-sources project --settings <file>`.
  - Codex: isolated `CODEX_HOME`, then trust the hooks once via the interactive "Trust all" prompt.

### Shell reporter

- In POSIX sh, split jq output on `\037`, not tab, because tab is IFS whitespace and empty fields collapse.
- Hooks must never exit 2, which blocks a Claude tool. jfm-emit uses 64 for usage errors.
- Pass the token to curl via `-K /dev/fd/3` so it stays out of argv.
- Node tests that drive jfm-emit against an in-process mock server must use async spawn, and must clear the HERDR_* env vars.

### Review-round lessons (2026-10-29)

- Adding a `sessions` column touches every one of these: `types.ts` SessionRow, reducer `newSession`/`ROW_KEYS`, store `SESSION_COLUMNS`/`toRow`, the `schema.ts` CREATE TABLE, and a `SCHEMA_MIGRATIONS` entry. `CREATE TABLE IF NOT EXISTS` never alters an existing table.
- Codex `request_user_input_async`: a `tool_start` or an ordinary tool's PostToolUse must not clear blocked/question, because Codex keeps running tools while the question is open. `UnblockedEvent.kind` exists for this.
- Claude and Codex subagents reuse the parent's `session_id`, so any per-session state (jfm-emit markers, blocked owner) must also be keyed by `agent_id`. Codex PermissionRequest.tool_input has an extra `description`, so ignore it when pairing Pre/Post events.
- Under dash, a failed redirection on a special builtin (`: >file`) exits 2, which is the hook block code. Write markers with `printf`/`touch ... || :`.
- Reaping replaced sessions by pane is limited to Codex: nested `claude -p`/`codex exec` runs inherit HERDR_PANE_ID/TMUX_PANE. omp's main `ctx.agent.id` is always `"Main"`, so it cannot identify a session.
- omp `/branch`, `/fork` and `/btw` mint a new session id and fire only `session_branch`, never `session_switch`.
- The 304 path of `/api/state` must still account for ended sessions ageing out of the 1h/24h window. The web client also filters `endedAt > now - window` on every render, because hidden tabs can resume hours later.
- `hono/body-limit` trusts Content-Length, so put it after header-only auth so unauthenticated callers never get their body buffered.
- `claude -p` fires SessionEnd right after Stop, so a headless E2E session ends in `ended` with lastMessage set, not in `done`.
- E2E without touching user config: put XDG_CONFIG_HOME/XDG_STATE_HOME into the hook command string and call jfm-emit by absolute path.
- Playwright is not a repo dependency. `scripts/screenshot.mjs` works with `PLAYWRIGHT_MODULE=<other project>/node_modules/playwright-core` and the cached `~/.cache/ms-playwright/chromium_headless_shell-1243`.
- The heavy-gate hook rejects Bash commands it cannot shlex-parse and inline `node -e`, so put those commands in script files.
- The hook also shlex-parses script files passed to bash/python (`bash -n local/install.sh` is refused because of its `'\'` case pattern); syntax-check install.sh through `local/test/install.test.mjs` instead.
- Rename migration (job-farm-mon -> job-farm-monitor): install.sh validates config and hook JSON before moving anything, leaves relative compat symlinks `job-farm-mon -> job-farm-monitor`, and sets a losing legacy dir aside as `job-farm-mon.migrated-<time>`. The omp registry also adopts/publishes `Symbol.for("job-farm-mon.omp.registry")`.
- `entry.node.ts` honours `HOST` (e.g. 127.0.0.1 for local runs); leave it unset on Railway.

### Privacy boundary fixes (2026-10-29)

- Schema v3 removes `events.raw_json`; events are deduplication metadata only. Preserve old IDs during migration so queued retries cannot recreate sessions. Do not reintroduce payload/replay storage without an explicit privacy-contract change.
- Reporter minimization must run both at enqueue and before upload: existing outbox files can predate the policy or `JFM_REDACT` setting. Keep raw blocked-call fingerprints local so permission pairing still works after minimization.
- `JFM_DISABLE` must gate the flusher before locks, cleanup or network, not just hook collection. Config changes do not cancel an already-running process/request.
- OMP terminal `stopReason: "error"` can carry either `errorMessage` or partial assistant text. Redact both paths; normal-success and retry-only coverage is insufficient.

### Rename to job-farm-monitor (2026-10-29)

- `local/install.sh` migrates pre-rename installs: `job-farm-mon` config/state dirs move to `job-farm-monitor` before `write_config` (new dirs win if both exist; queued outbox files are still moved over), and the old omp extension `job-farm-mon.ts` is removed, because oh-my-pi would otherwise load both and double-report. A flusher that is still running keeps working in the moved outbox, since it has `cd`'d into it, so only a lock whose owner is dead gets dropped.

### TLS and deployment pins (2026-10-29)

- eMudhra remediation needs a patched verifier, not just an SDK or root removal: cross-signed intermediates provide alternate trust chains. Node 24.22.1 rejects the compromised keys; both `fetch` and `https` in the built image rejected all 14 advisory test chains with `CERT_REVOKED` while positive controls worked.
- Docker shares one base across build/runtime: `node:24.22.1-alpine3.24` plus the multi-architecture digest in `Dockerfile`, `ca-certificates=20261020-r0`, and npm 12.2.1. The official base ships npm 11.19.1, so explicitly upgrade it before `npm ci` to enforce npm 12's `allowScripts`. Refresh tag, digest, CA pin, `.nvmrc`, and engine requirements deliberately for future updates.
- Vercel supports only major-version selection (`packages/server/package.json` uses `24.x`), not an exact function patch pin. Root engines enforce the build security floor; explicit `npx --yes npm@12.2.1` commands select the package manager. Verify the live function separately; `/api/health` is not a TLS patch report.
- Workers Builds honors root `.nvmrc` and exact `packageManager`; `engines.npm` alone does not select npm. Use `SKIP_DEPENDENCY_INSTALL=1` and `npm ci` for lockfile installation. Workers' `compatibility_date` selects API behavior, not a runtime security version.
- This repository has no Python/uv runtime. Reporter curl/system CA and OMP's host Node/Bun must be patched separately. Never disable TLS validation or assume a browser test proves another runtime's trust path.
- Docker's automatically assigned published port can change on restart (`-p 127.0.0.1::8080`). Re-read `docker port` before the post-restart persistence request; reusing the old port produces a false health failure.
