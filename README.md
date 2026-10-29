# job-farm-monitor

> **中文简介**：job-farm-monitor 是一个自托管的远程仪表盘，一眼看清多台机器上每个 coding
> agent（Claude Code、Codex CLI、oh-my-pi）当前是 **进行中 / 等待授权 / 等待回答 / 完成 /
> 出错 / 已结束**。各 agent 通过自己的 hook 或扩展把事件上报到你部署的 API；同一份代码可部署到
> Cloudflare Workers、Railway 或 Vercel（三选一即可）。下文为英文完整说明：部署步骤、token
> 生成、每台机器安装、Codex `/hooks` 信任、排障、免费额度估算与 `JFM_REDACT` 隐私选项。

job-farm-monitor is a self-hosted dashboard that shows, at a glance, what every
coding agent on every one of your machines is doing: **working**, **waiting for
permission**, **waiting for an answer**, **done**, **error** or **ended**. Agents
report through their own hooks/extensions; nothing polls your machines. A
session that stops reporting (killed process, lost network) is flagged as
"no update for Xm" after 10 minutes.

- Waiting sessions are pinned to the top with the reason (command to approve,
  question asked).
- Working sessions show their 4 latest progress lines (tool + command/path
  summary) with relative times; subagents fold into the parent card.
- Done sessions show the last reply (≤ 300 chars); ended ones are folded.
- UI in English and Chinese, light/dark, works on a phone.

Contents: [Architecture](#architecture) ·
[Tokens](#1-generate-tokens) · [Cloudflare](#2a-cloudflare-workers--durable-object-recommended) ·
[Railway](#2b-railway-docker--volume) · [Vercel](#2c-vercel--turso) ·
[Install on each machine](#3-install-the-reporter-on-each-machine) ·
[Codex trust](#codex-hooks-trust-and-quirks) · [Privacy](#privacy-jfm_redact) ·
[Troubleshooting](#troubleshooting) · [Free-tier usage](#free-tier-usage-estimate) ·
[Development](#development)

## Architecture

```
[Claude Code hooks]──┐
[Codex hooks.json]───┼─> jfm-emit (sh) ─> ~/.local/state/job-farm-monitor/outbox/*.json ─┐
[omp extension .ts]──┘ (in-process fetch, in-memory retry)                           │ background curl, batched POST
                                                                                     ▼
                                   POST /api/ingest  (Bearer <write token>; host label comes from the token)
                                                     │
                      Hono app (packages/server) ── core: normalize → reduce → Store(SqlDriver)
                                                     │
          Cloudflare: Worker → DO (JfmStore, SQLite) │ Railway: node:sqlite on /data │ Vercel: Turso (libSQL)
                                                     │
                      GET /api/state?since=rev  ◄── dashboard (Preact), polls every 3 s, 304 when unchanged
```

- `local/bin/jfm-emit` (POSIX sh + jq + curl) is called by Claude Code and
  Codex hooks. It writes the event to a local outbox and returns in ~10–20 ms;
  a detached flusher POSTs batches (≤ 100) and keeps the outbox (≤ 500 files)
  while the server is unreachable.
- `local/omp/job-farm-monitor.ts` is an oh-my-pi extension that POSTs directly with
  `fetch` (2 retries, 3 s timeout).
- One write token per machine (`WRITE_TOKENS="label:token,..."`): the host label
  on the dashboard comes from the token, so machines cannot impersonate each
  other. One read token (`READ_TOKEN`) for the dashboard.
- The same SQLite schema runs on all three platforms. Event deduplication metadata
  older than 7 days and sessions ended more than 24 h ago are removed during
  cleanup, every 500 changed ingest revisions (no cron; not a strict expiry timer).

| Package | What |
|---|---|
| `packages/core` | types, envelope parsing, normalizers, reducer, Store, SQLite drivers |
| `packages/server` | Hono API + entries for Cloudflare, Node/Railway, Vercel |
| `packages/web` | Preact dashboard (static, served by every platform) |
| `local` | `jfm-emit`, hook snippets, oh-my-pi extension, `install.sh` |

## Deploy

Use Node **24.22.1** (`.nvmrc`) and npm **12.2.1** at the repo root.
Root `engines.node` accepts `>=24.22.1 <25` (security floor within Node 24);
the server's `24.x` selects Vercel's managed major, not an exact patch:

```sh
git clone <this repo> job-farm-monitor && cd job-farm-monitor
nvm install && nvm use
npm install --global npm@12.2.1
npm ci
```
`npm ci` consumes the committed lockfile; use `npm install` only when deliberately
updating it. `.npmrc` enforces the engine requirements and saves exact dependency
versions. npm 12 also enforces the version-specific `allowScripts` policy:
esbuild/workerd are approved; the optional macOS fsevents rebuild is denied.
Review new install-script versions before approving them.


Pick **one** platform (2a, 2b or 2c). Each serves both the API and the dashboard
from one origin; that origin is your `JFM_ENDPOINT`.

### TLS security updates (eMudhra/emSign)

The [eMudhra compromise advisory](https://blog.cloudflare.com/emudhra-certificate-compromise/)
requires updating the **actual certificate verifier**, not just an SDK or lockfile.
[Node 24.22.1](https://nodejs.org/en/blog/release/v24.22.1) rejects chains
containing compromised public keys. Removing one root certificate alone is not
sufficient: an alternate/cross-signed chain can still reach another trusted root.
Update custom/extra CA bundles too; never restore affected trust or bypass TLS
verification (`curl -k`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, or `strict-ssl=false`).

- **Local/build tooling:** install the versions above before `npm ci`; restart
  long-running processes after updating their runtime. A dependency update alone
  does not patch Node's TLS implementation.
- **Deployments:** rebuild and redeploy after runtime/dependency changes. Refresh
  the Docker base tag **and digest** for future security releases: a digest is
  immutable, so `docker build --pull` cannot update an old pinned digest. Check
  the running container/function, not only the build log. `/api/health` reports
  application health/driver, not TLS patch status.
- **Each reporting machine:** update curl's TLS backend and its effective OS/CA
  trust store through the OS vendor. The shell reporter uses curl; the OMP
  extension uses its host process's `fetch`. Upgrade/restart OMP's own Node/Bun
  runtime independently (including bundled runtimes); this repo's `.nvmrc` does
  not change an already-installed agent. Audit `NODE_EXTRA_CA_CERTS`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`, and `CURL_CA_BUNDLE` where used.
- **Other Python services only:** this repository is Node/TypeScript and needs
  no Python/uv configuration. Independently update
  [uv to 0.13.5 or a newer fixed release](https://github.com/astral-sh/uv/releases/tag/0.13.5)
  (uv's own verifier), and the Python interpreter to
  [3.15.2](https://www.python.org/downloads/release/python-3152/),
  [3.14.10](https://www.python.org/downloads/release/python-31410/),
  [3.13.18](https://www.python.org/downloads/release/python-31318/),
  [3.12.16](https://www.python.org/downloads/release/python-31216/), or
  [3.11.18](https://www.python.org/downloads/release/python-31118/)
  (or a vendor build carrying the same compromised-key rejection). Update
  [certifi](https://pypi.org/project/certifi/) to at least 2026.10.19, pip to
  **26.2.2 or newer** (its separately vendored certificate bundle), and system/custom CA stores as
  applicable. Upgrading uv alone does not replace existing interpreters or
  virtual environments; install the fixed interpreter, recreate/repoint each
  environment, refresh its locked dependencies, and restart/redeploy services.
  Follow the [Python security team's guidance](https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576)
  for securely bootstrapping updates from an affected environment.

For each deployed/client path, follow the advisory's linked
[non-browser test instructions](https://emudhra.we-have-a-problem.com/) using
the **same runtime, TLS library, environment and CA configuration** as the
application. Confirm affected chains are rejected and normal HTTPS still works.
A browser/curl result does not establish that Node, OMP, Python, or a managed
function uses the same verifier. These are operator steps, not a claim that any
deployment or reporting machine has been patched or tested.

Example manual probes (run in the relevant machine/container; use a private
function diagnostic for managed functions):

```sh
node --version; npm --version; curl --version
curl --max-time 15 https://probe-emudhra.we-have-a-problem.com/
node --input-type=module -e 'const r = await fetch("https://probe-emudhra.we-have-a-problem.com/", {signal: AbortSignal.timeout(15000)}); console.log(r.status, await r.text());'
for chain in dv-g3b dv-g3b-aaa dv-g3b-noct dv-g3b-aaa-noct; do
  url="https://${chain}-emudhra.we-have-a-problem.com/"
  curl --max-time 15 -I "$url"
  node --input-type=module -e 'try { const r = await fetch(process.argv[1], {signal: AbortSignal.timeout(15000)}); console.error("ACCEPTED", r.status); } catch (e) { console.error(e.cause?.code ?? e.name, e.cause?.message ?? e.message); }' "$url"
done
```

All four affected endpoints should fail with an explicit certificate validation
error (curl normally exits 60); an HTTP response means the chain was accepted.
DNS failures, timeouts, and generic connection errors are **inconclusive**, not
a pass. Also request a known-good HTTPS endpoint through the same client and
confirm it succeeds. These four probes cover direct/AAA cross-signed and No CT
variants, not every affected intermediate in the linked full test suite.

### 1. Generate tokens

```sh
openssl rand -hex 24   # READ_TOKEN  (dashboard login)
openssl rand -hex 24   # one write token per machine
```

`WRITE_TOKENS` is a comma-separated list of `label:token` pairs, for example
`WRITE_TOKENS=kvm16188:3f9c...,macbook:a71e...`. The label is the host name shown
on the dashboard (no `/`, `,` or `:` in it). To revoke a machine, remove its
pair and redeploy/update the variable. Changing `READ_TOKEN` logs out every
browser.

Keep tokens out of git, shell history and chat logs.

### 2a. Cloudflare Workers + Durable Object (recommended)

The Worker serves `packages/web/dist` as static assets and routes `/api/*` to a
single SQLite-backed Durable Object (`JfmStore`). Works on the Workers Free plan.

```sh
npx wrangler login                                      # opens a browser
cd packages/server
npx wrangler secret put READ_TOKEN                      # paste the read token
npx wrangler secret put WRITE_TOKENS                    # paste label:token,label2:token2
cd ../..
npm run deploy:cf                                       # builds core + web, then wrangler deploy
```

- On the very first `secret put`, wrangler asks whether to create the Worker
  `job-farm-monitor`; answer yes. (Alternatively run `npm run deploy:cf` first and
  add the secrets afterwards; until then login and ingest are disabled.)
- The Worker URL is printed by the deploy, e.g.
  `https://job-farm-monitor.<your-subdomain>.workers.dev`. Check it:
  `curl https://job-farm-monitor.<sub>.workers.dev/api/health` →
  `{"ok":true,"version":"0.1.0","driver":"do-sqlite"}`.
- The Worker name, DO binding and assets are in `packages/server/wrangler.jsonc`.
  Secrets are never put in `vars`.
- Local Node runs npm/Wrangler/builds; production Workers use Cloudflare's
  managed runtime, not `.nvmrc` or the Docker image. The configured
  `compatibility_date: "2026-10-29"` selects API behavior, **not a security patch
  version** ([compatibility-date policy](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)).
  Keep local tooling patched and redeploy changed code/dependencies; confirm
  managed-runtime mitigation with Cloudflare and validate the Worker's actual
  outbound TLS path rather than inferring protection from that date.
  For hosted Workers Builds, use the repo root as the build root. The checked-in
  `.nvmrc` and `packageManager` select Node 24.22.1 and npm 12.2.1
  ([build-image controls](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)).
  Set `SKIP_DEPENDENCY_INSTALL=1`, build command `npm ci`, and deploy command
  `npm run deploy:cf` so dependency installation consumes the lockfile. Remove
  stale `NODE_VERSION` overrides and review Cloudflare's
  [patched build-image guidance](https://developers.cloudflare.com/changelog/post/2026-10-23-build-images-emudhra-certificates/),
  including custom CA/`NODE_OPTIONS` overrides. A patched build image is still
  not evidence about the deployed runtime.

### 2b. Railway (Docker + volume)

The root `Dockerfile` (`node:24.22.1-alpine3.24`, multi-stage, pinned to
`sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53`) runs
`packages/server/dist/entry.node.js`, which stores data with `node:sqlite` and
serves the dashboard. `railway.json` selects the Dockerfile and the
`/api/health` health check.

1. `railway login` (or use the web UI), then create a new project → **Deploy
   from GitHub repo** → this repository. The repo root is the service root;
   Railway picks up `railway.json` and builds the `Dockerfile`.
2. Add a **Volume** to the service with mount path **`/data`** (service →
   Settings / right-click → *Attach volume*). The Dockerfile has no `VOLUME`
   instruction because Railway rejects it.
3. Set variables on the service:

   | Variable | Value |
   |---|---|
   | `READ_TOKEN` | the read token |
   | `WRITE_TOKENS` | `label:token,...` |
   | `JFM_DB_PATH` | optional; default `${RAILWAY_VOLUME_MOUNT_PATH}/jfm.sqlite` = `/data/jfm.sqlite` |

   `PORT` is provided by Railway (the image defaults to 8080).
4. Settings → Networking → **Generate Domain**. Check
   `https://<app>.up.railway.app/api/health` → `"driver":"node-sqlite"`.

Data lives on the volume, so redeploys and restarts keep it. To try the image
locally:

```sh
docker build -t job-farm-monitor .
docker run --rm -e READ_TOKEN=r -e WRITE_TOKENS=dev:w -v "$PWD/tmpdata:/data" \
  -p 127.0.0.1:8080:8080 job-farm-monitor
```

[Railway's Docker builder](https://docs.railway.com/builds/dockerfiles) uses the
Dockerfile's base image for both build and runtime; `.nvmrc` and
`RAILPACK_NODE_VERSION` do not override a `FROM` instruction. Confirm the build
log says `Using detected Dockerfile!`, rebuild/redeploy the updated image, then
check `node --version`, `npm --version`, and the actual outbound TLS verifier in
the running service. The Dockerfile is the source of truth for the exact image
digest. If deliberately switching to [Railpack](https://railpack.com/languages/node/),
set `RAILPACK_NODE_VERSION=24.22.1` (highest-priority Node override), retain
`npm@12.2.1` in `packageManager`, and recheck generated build/runtime versions
and CA stores; this repository selects Docker, not Railpack.
The shared Docker base explicitly installs `ca-certificates=20261020-r0`
([Alpine package](https://pkgs.alpinelinux.org/package/v3.24/main/x86_64/ca-certificates))
and npm 12.2.1 for both stages; the OS CA bundle and Node's verifier/key
blocklist are separate updates.

### 2c. Vercel + Turso

On Vercel the API runs as one Node function backed by a Turso (libSQL)
database; the dashboard is copied into `packages/server/public` and served as
static files.

1. Create the database (Turso CLI, after `turso auth login`):

   ```sh
   turso db create job-farm-monitor
   turso db show job-farm-monitor --url          # -> TURSO_DATABASE_URL (libsql://...)
   turso db tokens create job-farm-monitor       # -> TURSO_AUTH_TOKEN
   ```

   The schema is created automatically on the first request.
2. `vercel login`, then import the repository as a new project (web UI or
   `vercel link` at the repo root) and set **Root Directory = `packages/server`**
   (Project → Settings → Build and Deployment). Keep "Include files outside the
   root directory in the Build Step" enabled: the build runs at the repo root.
3. Leave framework/install/build settings to `packages/server/vercel.json`:
   - `framework: "hono"`
   - `installCommand: cd ../.. && npx --yes npm@12.2.1 ci`
   - `buildCommand: cd ../.. && npx --yes npm@12.2.1 run build && mkdir -p packages/server/public && cp -r packages/web/dist/. packages/server/public/`
   - Select **Node.js 24.x** in Project Settings. Vercel supports only major
     versions and rolls out patch updates itself; an exact local `.nvmrc` or
     `engines` requirement is not a managed-runtime patch pin
     ([official version policy](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)).
     Redeploy after updates and verify the deployed **function's**
     `process.version` and outbound TLS behavior with platform logs/a temporary
     private diagnostic, then remove that diagnostic. Build-time `node -v`
     alone does not establish the function's patch level. Require 24.22.1 or a
     later fixed 24.x/vendor-equivalent verifier; if unavailable, obtain
     confirmation from Vercel rather than weakening TLS. Ensure the install
     environment actually invokes npm 12.2.1 via the explicit `npx` commands
     above, rather than relying on `packageManager` or a default builder npm
     ([package-manager policy](https://vercel.com/docs/package-managers)).
4. Environment variables (Production, and Preview if you use it):
   `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `READ_TOKEN`, `WRITE_TOKENS`.
5. Deploy: push to the connected Git branch, or `vercel deploy --prod` from the
   repo root. Check `https://<project>.vercel.app/api/health` →
   `"driver":"libsql"`.

Why there is a root `packages/server/index.js`: Vercel's Hono preset picks the
first of `app`, `index`, `server`, `src/app`, `src/index`, `src/server` whose
source imports `hono`, and its file tracing drops the npm-workspace symlink
`node_modules/@jfm/core`. So `index.js` does `import 'hono'` and re-exports the
tsup bundle `dist/entry.vercel.js`, which has `@jfm/core` inlined. That is also
why the build must run (`npm run build`) before Vercel traces the function.
Do not run `npx vercel build` inside your working copy: its install command
(`npx --yes npm@12.2.1 ci`) replaces the repo's `node_modules`. Use a scratch copy.

### 3. Install the reporter on each machine

Requirements: `bash`, `jq`, `curl` (and `setsid` or `nohup`). On every machine
that runs agents, with that machine's own write token:

```sh
local/install.sh --endpoint https://job-farm-monitor.<sub>.workers.dev --token <this machine's write token>
```

What it does (idempotent; re-run it any time):

- writes `~/.config/job-farm-monitor/config` (mode 0600; `KEY=value` lines,
  environment variables override it). Without flags it keeps an existing
  config; with flags it updates only those keys.
- installs `~/.local/bin/jfm-emit`.
- merges `local/claude.hooks.json` into `~/.claude/settings.json` and
  `local/codex.hooks.json` into `~/.codex/hooks.json`, keeping your other hooks;
  a `<file>.bak-jfm` backup is written first.
- copies `local/omp/job-farm-monitor.ts` to `~/.omp/agent/extensions/`.
- skips an agent whose home dir (`~/.claude`, `~/.codex`, `~/.omp`) is missing;
  `--no-claude`, `--no-codex`, `--no-omp` skip one explicitly.
- migrates a machine set up under the old name `job-farm-mon`: it moves
  `~/.config/job-farm-mon` and `~/.local/state/job-farm-mon` (config, queued
  events) to the new `job-farm-monitor` paths unless those already exist, and
  removes the old `~/.omp/agent/extensions/job-farm-mon.ts`. The Codex hook
  `statusMessage` changed with the rename, so re-trust the hooks via `/hooks`.

Then:

1. Restart running agent sessions so they load the hooks.
2. In Codex, run `/hooks` and trust the job-farm-monitor hooks (see below).
3. Run `~/.local/bin/jfm-emit --check`: it prints the endpoint and
   `HTTP 200 {"accepted":0,"ignored":0,"revision":N}` when endpoint and token work.
4. Open the dashboard once as `https://<your endpoint>/#token=<READ_TOKEN>`: it
   logs in (30-day HttpOnly cookie) and removes the token from the URL. Or paste
   the read token on the login page.

Uninstall: `local/install.sh --uninstall` (add `--purge` to also delete the
config and the state directory, including leftover `job-farm-mon` ones).

#### Codex hooks: trust and quirks

- Codex must have hooks enabled in `~/.codex/config.toml`
  (`[features]` / `hooks = true`); the installer prints a note if not, but never
  edits `config.toml`.
- Codex only runs hooks you have trusted. After installing, open Codex and run
  **`/hooks`**, then trust the new entries. The trust hash covers the command
  string: any change to a hook command in `hooks.json` (for example a different
  `jfm-emit` path) **silently** drops trust, also for `codex exec`. If Codex
  sessions stop appearing, run `/hooks` again.
- Interactive Codex does not fire `SessionEnd` on `/exit` or `/clear`; it only
  fires when its app-server daemon stops. Finished Codex sessions therefore
  usually stay "done" rather than "ended". When a new Codex session starts in
  the same herdr pane (or tmux pane), the server ends the older one.
- Codex caps `SessionEnd`/`Interrupt` hooks at a few seconds; `jfm-emit` only
  writes to the outbox and returns in milliseconds, so this is never an issue.

### Privacy: `JFM_REDACT`

Reporters send session/host/model/terminal metadata and bounded display text:
the first nonblank prompt line (≤ 120 chars), selected tool-summary inputs,
and reply/error/wait text (≤ 300). Tool inputs are allowlisted: file tools send
paths, not file contents or edit replacements; patches send file headers, not
diff bodies. Custom instructions, transcript paths and tool responses are not
uploaded. Full working-directory and file paths can still be sent by default.

The server stores session/progress summaries and metadata; the event table
contains only deduplication metadata, never payloads. Summaries can themselves
contain secrets: truncation is not secret detection. To suppress content, add
to `~/.config/job-farm-monitor/config` (or the environment):

```sh
JFM_REDACT=1
```

With it, both reporters blank prompt, tool-input/summary, question, reply and
error text, including terminal failures and partial-reply fallbacks. Working
directories become project basenames. Session/host/model/terminal identifiers,
tool names, state and project names remain visible; this is not anonymization.
The shell reporter reapplies minimization and current redaction when flushing,
so an older queued payload cannot bypass the upload policy.

`JFM_DISABLE=1` stops new collection and makes `jfm-emit --flush` leave the queue
untouched without sending. Re-enabling can send that queue. Configuration is
read once per shell invocation / OMP extension initialization: restart OMP to
change its policy; already-running flushes and in-flight requests are not
cancelled. `--check` remains an explicit connectivity diagnostic.

**Upgrade:** redeploy the server, rerun `bash local/install.sh` on reporting
machines (existing configuration is kept), and restart agent sessions. Schema
v3 removes the legacy `events.raw_json` column while preserving event IDs and
dashboard state. This is logical deletion, not forensic erasure: existing
backups, local queued/rejected files and prior raw recordings are not scrubbed.
Queued files are sanitized for upload, not rewritten in place.

`JFM_RECORD_DIR` / `--record` explicitly saves raw local stdin even with
redaction enabled. Local blocked-call markers also contain a short tool-input
fingerprint; neither is uploaded. Keep the state directory private and use a
trusted HTTPS endpoint for remote reporting.

## Troubleshooting

| Check | How |
|---|---|
| Server up? | `curl https://<endpoint>/api/health` → `{"ok":true,"version":"0.1.0","driver":"..."}` (no auth) |
| Endpoint + token from this machine | `~/.local/bin/jfm-emit --check` → `HTTP 200`; `HTTP 401` = wrong/revoked token; exit 2 = not configured |
| Events queued but not sent | `ls ~/.local/state/job-farm-monitor/outbox/` (pending envelopes, max 500, oldest dropped) |
| Why sending fails | `~/.local/state/job-farm-monitor/emit.log` (HTTP errors, curl failures; rotates at 1 MiB; never contains the token) |
| Retry now | `~/.local/bin/jfm-emit --flush` |
| Capture raw hook payloads | set `JFM_RECORD_DIR=<dir>` in the config; payloads are saved as `<agent>-<event>-<ms>.json` |
| Dashboard shows "no update for Xm" | the agent stopped reporting for ≥ 10 min while working/waiting: process killed, network down, or (Codex) hooks no longer trusted |
| "delayed" badge on a card | events arrived > 60 s after they happened (outbox replay after an outage, or clock skew) |
| Codex sessions missing | run `/hooks` in Codex and trust the entries; check `hooks = true` in `config.toml` |
| Claude sessions missing | `jq '.hooks | keys' ~/.claude/settings.json` should list the hook events; restart the session |
| oh-my-pi sessions missing | `ls ~/.omp/agent/extensions/job-farm-monitor.ts`; the extension registers nothing when endpoint/token are missing or `JFM_DISABLE=1` |

`$XDG_STATE_HOME` / `$XDG_CONFIG_HOME` replace `~/.local/state` / `~/.config`
when set.

## Free-tier usage estimate

Load comes from two sources:

- **Dashboard polling**: one visible tab polls every 3 s = 1,200 requests/hour,
  ~19,200/day for 16 h. Hidden tabs pause polling; unchanged state answers 304.
- **Ingest**: one POST per flush (batches up to 100 events). PreToolUse is
  throttled to 1 per session per 2 s and PostToolUse is only sent after a
  wait, so a busy agent produces roughly a few hundred events per hour.

| Platform | Free allowance (check current pricing) | Rough use: 1 tab × 16 h + 3 busy agents × 8 h |
|---|---|---|
| Cloudflare Workers Free | 100,000 Worker requests/day; DO: 100,000 requests/day, 5 M SQLite rows read/day, **100,000 rows written/day**, 5 GB | ~20 k polls + ≤ ~10 k ingest POSTs: fine on requests. Each event writes roughly 10–15 SQLite rows (event, session, progress line, trims, revision, index entries), so the **rows-written** limit is the one to watch: about 7–10 k events/day. Exceeding it makes writes fail until 00:00 UTC; Workers Paid ($5/month) lifts it. |
| Vercel Hobby + Turso Free | Vercel Hobby: function invocations are capped monthly (about 1 M); Turso Free: 500 M rows read, 10 M rows written per month, 5 GB | one tab 16 h/day ≈ 580 k polls/month, so one tab plus agents fits; several always-open tabs may not. |
| Railway | usage-based (trial / Hobby credit) | one small always-on container + a 1 GB volume; no per-request limits. |

These are estimates, not measurements; watch the platform's usage page in the
first days.

## Development

```sh
nvm install && nvm use   # .nvmrc: 24.22.1
npm install --global npm@12.2.1
npm ci
npm run build          # core -> server -> web
npm run typecheck && npm run lint && npm test
```

Local servers (both listen on port 8787; the Vite dev server proxies `/api` there):

```sh
READ_TOKEN=dev-read WRITE_TOKENS=dev:dev-write npm run dev:node   # tsx watch, node:sqlite at ./data/dev.sqlite
npm run dev:web                                                   # Vite on http://localhost:5173
npm run dev:cf      # wrangler dev (Worker + DO); put READ_TOKEN=... and WRITE_TOKENS=... in packages/server/.dev.vars
JFM_MOCK=1 npm run dev -w @jfm/web                                # dashboard with a fake /api, no server needed
```

Seed demo data (sessions in every section, built from
`packages/core/test/fixtures`, timestamps spread over the last 30 minutes):

```sh
JFM_WRITE_TOKEN=dev-write npm run seed
# options: JFM_ENDPOINT (default http://127.0.0.1:8787),
#          JFM_WRITE_TOKEN=tokA,tokB (spreads sessions over several hosts),
#          JFM_READ_TOKEN (prints a state summary), --dry-run (print envelopes only)
```

Then open `http://localhost:5173/#token=dev-read`. Seeded cards carry the
"delayed" badge, because their timestamps are in the past.

Screenshots (V06; needs Playwright, runs one browser):

```sh
JFM_URL=http://127.0.0.1:8787 JFM_READ_TOKEN=dev-read \
  node scripts/screenshot.mjs /tmp/jfm-shots    # {375,1280}-{light,dark}.png + JSON checks
```

More: `AGENTS.md` (conventions, commands, lessons), `docs/contracts.md` (API and
types), `docs/plan.md` / `docs/todo.md` (spec and tasks, Chinese).
