# job-farm-mon 实施计划

- 日期：2026-10-29
- 状态：需求与决策已全部确认，可直接实施
- 范围：多机器 coding agent（Claude Code、Codex CLI、oh-my-pi）状态仪表盘

## Goal

做一个远程仪表盘 job-farm-mon，一眼看清多台机器上每个 coding agent 当前处于 **进行中 / 等待授权 / 等待回答 / 完成 / 出错 / 已结束** 哪种状态。信号由各 agent 自己的 hook 或扩展自动上报到自己部署的 API；进程被杀等无法上报的情况，靠“最后一次进展距今多久”来暴露。

成功标准：

- 在任一机器装好 hook 后，新开的 agent 会话无需手工登记就出现在页面上。
- 等待授权 / 等待回答的会话置顶并直接显示等待原因；完成的会话显示最后一条回复摘要；进行中的会话只显示最近 4 条进展和各自的相对时间。
- 任一进行中会话超过 10 分钟没有新事件，页面明确标出“无更新 Xm”。
- 同一份代码可部署到 Cloudflare Workers、Railway、Vercel 三个平台，读写 token 分离。

## Confirmed decisions

用户已确认：

- 后端三平台都要支持：Cloudflare Workers + Durable Object、Railway、Vercel。
- 信号来源：各 agent 的 hook / 扩展直接上报，不轮询 herdr；事件顺带附上 `HERDR_PANE_ID` 等 id。
- 多台机器：每台机器一个独立写 token，一个读 token 给仪表盘。
- subagent 折叠进父会话卡片，不单独占卡片。
- 存储：一套 SQLite schema，三种驱动（DO SQLite / node:sqlite / Turso libSQL）。
- 前端实时性：统一轮询，3 秒一次，revision 没变返回 304，页面切后台暂停。
- UI 中英双语可切换，记在 localStorage。
- 云端只存摘要文本：工具名 + 命令/路径摘要（≤120 字）、prompt 首行（≤120 字）、等待授权/提问内容、最后一条回复（≤300 字）。

调研后做出的技术决定（无需再确认）：

- 服务端框架 Hono 4.13.x，与 auto-mode-gateway 一致；TypeScript 固定 5.9.x（npm 最新已是 7.0，生态兼容风险大，不用）。
- Cloudflare 侧用 Durable Object 自带 SQLite 而不是 D1：单实例串行执行天然解决并发归约，免费档没有 D1 的每日 10 万行写入上限。
- 本地上报器 `jfm-emit` 用 POSIX sh + jq + curl，先落本地 outbox 再后台异步发送，保证所有 hook 在 20ms 内返回（Codex 的 SessionEnd/Interrupt 超时只有 1 秒）。不用 Claude 的 `type: "http"` hook，因为它是同步的，会给每次工具调用加网络延迟。
- oh-my-pi 扩展在进程内直接用 `fetch` 上报，带内存重试队列；读同一份配置文件。
- 进展事件节流：同一会话 2 秒内最多发一条 `tool_start`；PostToolUse 只在该会话处于 blocked 状态或工具是“提问类”时才发送。
- 前端 Preact 11 + @preact/signals + Vite 8，构建产物三平台共用。
- 固定参数：卡片显示最近 4 条进展（服务端保留 10 条）；进行中/等待中超过 10 分钟无事件标 stale；事件保留 7 天；已结束会话折叠显示 1 小时、24 小时后不再返回。
- 时间显示以事件客户端时间戳为准，但若比服务端接收时间晚到超过 60 秒，卡片加“延迟送达”标记。
- 读端认证：登录页粘贴读 token，服务端下发 HttpOnly 签名 cookie（30 天），也接受 `Authorization: Bearer <读token>` 供脚本用；仪表盘静态文件公开，`/api/*` 全部受保护。支持首次访问用 `#token=` 片段自动登录后抹掉 URL。
- 无 CORS、无远程控制、无推送通知；这些是本期非目标。

## Relevant codebase context

- 仓库 `job-farm-mon` 为空，无提交，当前分支 master；首个提交前改名为 main。
- 本机（kvm16188）已安装：Claude Code 2.1.312、Codex CLI 0.165.0（`features.hooks = true`，hooks 在 `~/.codex/hooks.json`，改动后需在 Codex 里 `/hooks` 重新信任 hash）、oh-my-pi 18.13.3（`~/.omp/agent/extensions/*.ts` 自动发现，subagent 会话会重新绑定扩展工厂）。`~/.claude`、`~/.codex`、`~/.omp` 各自都是 git 仓库，已有 heavy-gate、提交署名拦截、herdr 等 hook，安装脚本必须合并而不是覆盖。
- 用户运行在 herdr 0.9.5 里。它用 OSC 7501 加自带集成脚本在本地算出 idle/working/blocked/done，`herdr agent list` 输出 JSON，但只有粗状态，没有进展行和最后回复，且只覆盖 herdr 内的 pane。它的 OMP 集成脚本 `~/.omp/agent/extensions/herdr-omp-agent-state.ts` 是 OMP 扩展事件映射的现成参考。
- 已核实的 hook 能力：
  - Claude Code：SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、PermissionRequest、Notification（`permission_prompt`、`idle_prompt`、`agent_needs_input`、`elicitation_dialog` 等）、Stop（含 `last_assistant_message`）、StopFailure、SubagentStart/SubagentStop（含 `agent_id`、`agent_type`）、PreCompact、SessionEnd（`reason`）。命令型 hook 支持 `async: true`。子 agent 内的工具事件也会触发并带 `agent_id`。
  - Codex 0.165.0：SessionStart、SessionEnd、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、SubagentStart、SubagentStop、Stop（含 `last_assistant_message`）、Interrupt。stdin 字段 `session_id`、`transcript_path`、`cwd`、`hook_event_name`、`model`、`turn_id`、`tool_name`、`tool_input`。子 agent 的 hook 复用父 `session_id`。有 `request_user_input` 工具可识别“提问”。
  - oh-my-pi：`session_start`、`session_switch`、`before_agent_start`、`agent_start`、`agent_end`（`willContinue`）、`turn_end`、`tool_execution_start/end`、`tool_approval_requested/resolved`、`plan_review_requested/resolved`、`auto_retry_start/end`、`session_shutdown`；`ctx.agent.kind` 为 `"main" | "sub"`，`ctx.sessionManager.getSessionId()`、`ctx.cwd`、`ctx.hasUI`。
- OSC 7501 结论：它是“程序 → 终端”的状态协议，状态词汇正好是 idle/working/done/blocked{permission,question,auth}/error。Codex 和 omp 无条件发射，Claude Code 只在终端应答 `OSC 7501 ; ?` 探测后才发射，herdr 就是靠它做零配置检测。它不能直接把状态送到云端，做远程仪表盘仍需 hook。本方案采用与它完全对齐的状态词汇，这样页面语义与 herdr/Ghostty 的标签一致；将来若要监控没有 hook 的 agent，可再加一个解析 OSC 7501 的 pty 包装器，本期不做。
- 工具链：Node 24.22（`node:sqlite` 已验证可用）、Bun 1.4.4、jq 1.8.1、curl、setsid 均在。本机没有 wrangler / railway / vercel CLI 和凭据，部署前需要用户自己登录。
- 依赖版本（2026-10-29 npm latest）：hono 4.13.14、@hono/node-server 2.1.5、@libsql/client 0.18.0、preact 11.1.0、@preact/signals 2.11.4、vite 8.3.5、wrangler 4.155.0、vitest 5.0.5、@cloudflare/vitest-pool-workers 0.23.0、@cloudflare/workers-types 5.20261029.1；TypeScript 固定 5.9.x。

## Recommended approach

### 总体结构

```
[Claude Code hooks]──┐
[Codex hooks.json]───┼─> jfm-emit (sh) ─> ~/.local/state/job-farm-mon/outbox/*.json ─┐
[omp extension .ts]──┘ (进程内 fetch，内存重试)                                          │ 后台 curl，批量 POST
                                                                                       ▼
                                   POST /api/ingest  (Bearer 写token，host 由 token 决定)
                                                     │
                      Hono app (packages/server) ── core: normalize → reduce → Store(SqlDriver)
                                                     │
          Cloudflare: Worker → DO(JfmStore, SQLite) │ Railway: node:sqlite@/data │ Vercel: Turso
                                                     │
                      GET /api/state?since=rev  ◄── 仪表盘 (Preact) 每 3 秒轮询，304 即跳过
```

### 方案比较

| 决策点 | 候选 | 选择与理由 |
|---|---|---|
| 信号来源 | hooks 直报 / herdr 轮询转发 / OSC 7501 pty 包装器 | hooks 直报：信息最丰富，不依赖 herdr，多机天然支持；herdr 和 OSC 7501 作为词汇对齐与未来扩展 |
| CF 存储 | Durable Object SQLite / D1 / KV | DO SQLite：单实例串行写，免费档无行写入上限；D1 免费档每日 10 万行写入，多 agent 时会顶到 |
| 跨平台存储 | SQLite 三驱动 / Postgres | SQLite 三驱动：同一 SQL，驱动层各约 50 行；Vercel 用 Turso，本地用 `file:` 测试 |
| hook 传输 | 命令 hook + outbox / Claude HTTP hook / 本地常驻守护进程 | outbox：零守护进程、毫秒返回、断网不丢（上限 500 条） |
| 实时性 | 轮询 / WebSocket | 轮询：三平台同一条代码路径，CF 免费档 10 万请求/天足够（单页签 16 小时约 1.9 万次） |
| 前端 | Preact + signals / 原生 TS | Preact：状态管理清晰，体积小 |

### 数据模型（SQLite，三平台同 schema）

- `sessions(key PK, host, agent, session_id, cwd, project, title, model, state, state_kind, state_msg, state_since, last_event_at, started_at, ended_at, last_message, subagents_json, herdr_pane_id, herdr_tab_id, herdr_workspace_id, hostname)`。`key = host/agent/session_id`。
- `progress(session_key, ts, text, agent_type)`，每会话保留最近 10 条。
- `events(id PK, session_key, ts, received_at, type, raw_json)`，保留 7 天，用于排障与重放。
- `meta(k PK, v)`：`revision`、`schema_version`。
- `SqlDriver` 接口：`exec(sql, params) → rows` 与 `writeTx(fn)`。实现：DO `ctx.storage.sql` + `transactionSync`；`node:sqlite` `BEGIN IMMEDIATE`；`@libsql/client` `transaction("write")`。归约在写事务内完成，三平台都无竞态。

### 上报信封（jfm-emit 与 OMP 扩展统一）

```json
{ "v": 1, "id": "<uuid>", "ts": 1761721234567, "agent": "claude|codex|omp",
  "hostname": "kvm16188", "pid": 12345,
  "env": { "herdr_pane_id": "wS:p1", "herdr_tab_id": "wS:t1", "herdr_workspace_id": "wS", "tmux_pane": "%3" },
  "payload": { "...hook 的 stdin 原文；omp 为精简事件对象..." } }
```

`POST /api/ingest` 接受数组（outbox 批量冲刷），单条非法只跳过不报错，整体 200，避免毒消息卡死队列。`id` 用于去重。

### 状态机（服务端归约，agent 无关）

状态：`idle`、`working`、`blocked(kind=permission|question)`、`done`、`error`、`ended`；`stale` 由前端根据 `last_event_at` 推算。规则：

- `session_start`：不存在则建会话为 idle；已存在且未 ended 则不改状态（Codex 子 agent 的 SessionStart 复用父 id）。
- `prompt`：→ working，`title` 更新为本次 prompt 首行。
- `tool_start`：→ working；追加进展行 `[agent_type] 工具: 摘要`。
- `blocked(kind,msg)`：→ blocked；`unblocked`：→ working。
- `turn_done(text)`：→ done，`last_message = text`。
- `error(text)`：→ error。`interrupt`：→ idle。
- `subagent_start/stop`：维护 `subagents_json`，卡片显示“↳ 2 个 subagent：Explore, Plan”。
- `compact`：追加进展“正在压缩上下文”。`session_end(reason)`：→ ended。
- 乱序保护：事件 `ts` 比会话 `last_event_at` 早 5 秒以上时只追加进展与 events，不改状态。
- 容错：Claude 的 `idle_prompt` 通知在会话仍为 working 时把它改为 done（防止 Stop 丢失）。

### 各 agent 事件映射

| 规范事件 | Claude Code | Codex | oh-my-pi |
|---|---|---|---|
| session_start | SessionStart(source) | SessionStart | `session_start` / `session_switch`（新 id 建新卡，旧卡 ended） |
| prompt | UserPromptSubmit.prompt | UserPromptSubmit.prompt | `before_agent_start.prompt` |
| tool_start | PreToolUse（全部工具，2 秒节流） | PreToolUse | `tool_execution_start` |
| blocked/permission | PermissionRequest；Notification `permission_prompt`（去重） | PermissionRequest（`tool_input.description` 或命令） | `tool_approval_requested.reason/toolName` |
| blocked/question | PreToolUse `AskUserQuestion`（首个问题）、`ExitPlanMode`（“等待批准计划”）；Notification `agent_needs_input`、`elicitation_dialog` | PreToolUse `request_user_input` | `tool_execution_start` 且 toolName=`ask`；`plan_review_requested` |
| unblocked | PostToolUse（仅 blocked 标记存在或提问类工具时发送） | PostToolUse（同上） | `tool_approval_resolved`、`tool_execution_end(ask)`、`plan_review_resolved` |
| turn_done | Stop.last_assistant_message | Stop.last_assistant_message | `agent_end` 且 `willContinue !== true`，取最后 assistant 消息 |
| error | StopFailure | 无（保持上一状态） | `agent_end` 最后消息 `stopReason === "error"`；`auto_retry_start` 回 working 并记“重试中” |
| interrupt | 无（Stop 不触发，保持） | Interrupt | 无 |
| subagent | SubagentStart/Stop；子 agent 内工具事件带 `agent_id/agent_type` 前缀 | SubagentStart/Stop；子事件带 `agent_type` | 子会话扩展实例读模块级 `rootSessionId` 归入父卡（见实现步骤 4 的验证分支） |
| compact | PreCompact | PreCompact | `session_before_compact` |
| session_end | SessionEnd.reason | SessionEnd | `session_shutdown` |

工具摘要函数 `summarizeTool(agent, tool, input)`：Bash/shell 取命令首行，Edit/Write/Read 取相对 cwd 的路径，Grep/Glob 取 pattern，Agent/task 取 description，Web 工具取 url/query，MCP 工具取 `server/tool` 名，其余取首个字符串字段；一律截到 120 字。

### 认证与多机

- 写：`Authorization: Bearer <token>`；环境变量 `WRITE_TOKENS="kvm16188:tokA,macbook:tokB"`，host 标签来自匹配到的 token，payload 里的 hostname 只作参考，机器之间无法冒名。常量时间比较。
- 读：`READ_TOKEN`；`POST /api/login {token}` 下发 cookie `jfm_s=<expiry>.<hmac>`，HMAC 密钥由 `READ_TOKEN` 派生，换读 token 即全体登出；`GET /api/me` 供前端判断登录态；`POST /api/logout`。
- token 用 `openssl rand -hex 24` 生成；本地配置文件 `~/.config/job-farm-mon/config` 权限 0600，不进任何 git 仓库。

### API

- `GET /api/health`：无需认证，返回版本与驱动名。
- `POST /api/ingest`：写 token；body 为信封或信封数组（≤100 条）。
- `GET /api/state?since=<rev>&ended=1h|24h`：读认证；revision 未变 304；否则返回 `{revision, now, sessions[]}` 全量快照（会话含最近 4 条进展，展开时请求 `GET /api/sessions/:key` 取 10 条与完整 last_message）。
- 清理：每 500 次 revision 变化在 ingest 事务内顺带执行一次 7 天/24 小时清理，三平台无需 cron。

### 部署形态

- Cloudflare：`packages/server/wrangler.jsonc`，`main` 指向 `src/entry.cloudflare.ts`；DO 类 `JfmStore`（`new_sqlite_classes`）暴露 RPC `ingest/state/session`；Worker 内 Hono 调 stub；`assets` 指向 `packages/web/dist`，`not_found_handling: single-page-application`，`run_worker_first: ["/api/*"]`；密钥 `wrangler secret put READ_TOKEN / WRITE_TOKENS`。
- Railway：多阶段 `Dockerfile`（node:24-alpine），`railway.json` 健康检查 `/api/health`；Volume 挂 `/data`，`JFM_DB_PATH` 默认 `${RAILWAY_VOLUME_MOUNT_PATH}/jfm.sqlite`；`@hono/node-server` + `serveStatic` 提供前端。
- Vercel：`src/entry.vercel.ts` 导出 Hono app；`vercel.json` 用 Hono 框架预设，静态产物复制到 `public/`；环境变量 `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`、`READ_TOKEN`、`WRITE_TOKENS`；本地开发 `TURSO_DATABASE_URL=file:./dev.db`。

### 前端布局

分区按优先级：🔴 等待处理（授权/提问）→ 🟡 进行中（stale 的排最前）→ 🟢 完成 / 空闲 → ⚪ 已结束（折叠）。每张卡一行头部：状态点、agent 图标、项目名（cwd 末段）、host 标签、标题（最新 prompt 首行）、距上次事件时间。卡体按状态：进行中显示 4 条进展各带相对时间；等待显示原因；完成显示最后回复两行截断；出错显示错误。点击展开 10 条进展、cwd、session id、herdr pane id。顶栏 host 筛选、各状态计数、连接状态、语言切换。移动端单列，跟随系统深浅色。相对时间每 10 秒刷新，用服务端 `now` 校正时钟偏差。

## Implementation steps

1. **仓库脚手架**：npm workspaces，`packages/core`（纯 TS）、`packages/server`、`packages/web`、`local/`；根 `package.json` engines `^24`；TypeScript 5.9.x、vitest 5.0.5、eslint 配置参考 auto-mode-gateway；`AGENTS.md`（含 Lessons 段）、`README.md`、`.gitignore`（排除 `*.sqlite`、`dev.db`、`.env*`、`dist`）。`git branch -M main` 后首个提交。
2. **采集真实 payload**：先写 `local/bin/jfm-emit` 的记录模式（`JFM_RECORD_DIR` 下按 `<agent>-<event>-<ts>.json` 保存 stdin 原文），临时装进三份配置，在本机各跑一轮短会话：普通 prompt、触发授权、触发提问、完成、启动 subagent、`/clear` 或退出。把样本整理进 `packages/core/test/fixtures/{claude,codex,omp}/`。验证 Codex 子 agent 的 SessionStart/工具事件实际字段：若 `agent_type` 存在则用它做前缀，否则退回 `agent_id`。
3. **core**：`types.ts`（信封、规范事件、Session）、`normalize/{claude,codex,omp}.ts`、`summarize.ts`、`reducer.ts`、`schema.sql.ts`、`store.ts`（基于 `SqlDriver`，含 revision、清理）、`drivers/node-sqlite.ts`、`drivers/libsql.ts`；DO 驱动放 server 包。
4. **local**：
   - `local/bin/jfm-emit <agent>`：读 stdin、读 `~/.config/job-farm-mon/config`、生成信封写入 outbox、按会话写 2 秒节流标记与 blocked 标记、`setsid`（无则 `nohup`）启动后台冲刷器；冲刷器用 `mkdir` 锁串行、批量 POST、2xx 删除、失败保留、超过 500 条丢最旧；`--flush`、`--check`（发空数组验证 token）、`--record`。
   - `local/claude.hooks.json`：上述 Claude 事件全部 `async: true`，SessionEnd 同步 `timeout: 3`。
   - `local/codex.hooks.json`：上述 Codex 事件 `async: true`，SessionEnd/Interrupt `timeout: 1`。
   - `local/omp/job-farm-mon.ts`：按映射表注册事件，直接 `fetch` 上报，内存队列重试两次；`ctx.agent.kind === "sub"` 时读取模块级 `rootSessionId` 归入父会话。验证分支：若子 agent 与主 agent 不在同一进程（`rootSessionId` 为空），子会话事件只发 `subagent_start/stop` 到自己的 session id 并由服务端按 `parentId` 挂到父卡；仍不可行则忽略子事件，父卡靠自身 `tool_execution_start` 显示“正在运行 subagent”。
   - `local/install.sh`：检查 sh/jq/curl；写配置（0600）；复制 `jfm-emit` 到 `~/.local/bin`；用 jq 幂等合并 Claude 与 Codex hook（先删除 command 含 `jfm-emit` 的旧条目再插入）；复制 OMP 扩展；打印提示“在 Codex 里运行 `/hooks` 信任新 hook”；`--uninstall` 逆操作；在每台机器重复执行即可。
5. **server**：`createApp({backend, auth})` 与路由、认证中间件、cookie 签名；`entry.cloudflare.ts`（Worker + `JfmStore` DO + DO SqlDriver）、`entry.node.ts`（Railway）、`entry.vercel.ts`；`wrangler.jsonc`、`Dockerfile`、`railway.json`、`vercel.json`。验证分支：若 Vercel 当前不接受 Hono 框架预设，改为 `api/index.ts` + `@hono/vercel` 的 `handle(app)` 并在 `vercel.json` 加 `/api/(.*)` 重写。验证 `run_worker_first` 在当前 wrangler schema 可用；不可用则在 Worker 内自行先匹配 `/api/*` 再回退 `env.ASSETS.fetch`。
6. **web**：Vite + Preact；`api.ts`（轮询、304、可见性暂停、时钟校正）、`i18n.ts`（zh/en 字典）、组件 `SessionCard`、`Section`、`Login`、`HostFilter`；样式变量支持深浅色；构建到 `packages/web/dist`。
7. **文档**：README 写三平台部署步骤（用户需要执行的登录命令：`wrangler login`、`railway login`、`vercel login`）、token 生成、每台机器安装、Codex 信任步骤、排障（`jfm-emit --check`、outbox 位置、`/api/health`）。
8. **验证与收尾**：按下一节执行；把实现中学到的版本或坑记入仓库 `AGENTS.md` 的 Lessons。

## Validation plan

- **单元测试（core）**：三个 normalizer 用步骤 2 的真实 fixture 覆盖每种事件；reducer 覆盖全部状态转移、乱序保护、idle_prompt 容错、subagent 计数；store 在 `node:sqlite` 与 `libsql file:` 两种驱动上跑同一套用例（revision 递增、304 条件、清理、去重）。
- **Worker 测试**：`@cloudflare/vitest-pool-workers` 跑 DO 驱动：ingest 批量 → state 快照 → 304 → 过期清理；登录 cookie 与错误 token 返回 401。
- **上报器测试**：bash 脚本 + Node 假服务器：正常发送、服务器 500 时 outbox 保留并在下次调用冲刷、500 条上限、节流标记、blocked 标记控制 PostToolUse 发送、SessionEnd 路径 1 秒内返回。
- **OMP 扩展测试**：用假 `pi` 对象驱动事件序列，断言发出的信封；再按 `~/.omp/AGENTS.md` Lessons 里的做法，用临时扩展加 `createAgentSession` 做一次无模型冒烟。
- **本机端到端**：三平台的本地开发模式各起一个（`wrangler dev`、`node entry.node`、`file:` 驱动的 Vercel 入口），对三个 agent 做同一张矩阵：提交 prompt、触发授权、触发提问、完成、启动 subagent、`kill -9` 后 10 分钟观察 stale 标记、退出会话。页面截图验证一律通过 `~/.claude/bin/heavy-gate -n 1 -- …` 后台运行，Playwright `--workers=1`。
- **部署冒烟**：用户登录后，每个平台部署一次，检查 `/api/health`、登录、`jfm-emit --check`、页面渲染与 304 轮询。
- **验收**：新会话 5 秒内出现；等待状态置顶且含原因；完成卡显示回复摘要；进行中卡只有 4 行进展；stale 标记在 10 分钟后出现；换错 token 返回 401；三平台行为一致。

## Risks and mitigations

| 风险 | 缓解 |
|---|---|
| Codex hook 协议仍在演进，改 `hooks.json` 后 hash 失效导致静默不触发 | 安装脚本每次都提示 `/hooks` 信任；`jfm-emit --check` 与页面 host 心跳缺失能暴露问题；fixture 测试锁住字段 |
| oh-my-pi 扩展 API 版本漂移（`~/.omp/AGENTS.md` Lessons 已记录多处） | 只用 18.13.3 类型定义里确认存在的事件；子 agent 归属按步骤 4 的分支降级 |
| Claude `Stop` 丢失或 stop hook 续跑造成短暂 done 闪烁 | `idle_prompt` 容错；下一次 `tool_start` 立即回 working |
| 免费额度：CF 10 万请求/天、Vercel Hobby 调用数 | 2 秒节流、PostToolUse 过滤、页面后台暂停、304 轻量响应；README 列出预估用量 |
| 断网或平台故障丢事件 | outbox 持久化重试；页面 stale 标记兜底 |
| 多机时钟偏差 | 服务端记录 `received_at`，显示以客户端 `ts` 为主并对迟到事件标记 |
| 摘要文本含敏感命令或路径 | 全部截断；配置项 `JFM_REDACT=1` 可只发工具名；token 文件 0600，Claude 已拒读 `.env*` |
| `node:sqlite` 在 Node 24 仍标“活跃开发” | 本机已验证；Dockerfile 固定 node:24；若出问题换 `@libsql/client` 的 `file:` 驱动，接口不变 |
| Vercel 的 Hono 预设或 Turso 免费档变化 | 步骤 5 的验证分支；libSQL 本地 `file:` 保证可测 |
| hook 阻塞 agent | 所有 hook 只写文件后立即返回；Claude/Codex 侧额外开 `async: true` |
