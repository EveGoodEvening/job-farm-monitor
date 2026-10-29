# Todo List

来源：`docs/plan.md`（2026-10-29 确认版）。本清单可直接作为进度追踪文件使用，例如 `/implement-planning docs/plan.md docs/todo.md`。完成一项就把 `[ ]` 改成 `[x]`。

## Locked decisions

- 三平台都要支持：Cloudflare Workers + Durable Object（SQLite）、Railway（Node 24 + `node:sqlite`，Volume 挂 `/data`）、Vercel（Turso / `@libsql/client`）。一个 Hono 4.13.x app，一套 SQLite schema，三个薄驱动，三个入口文件。
- 信号只来自各 agent 的 hook/扩展：Claude Code hooks、Codex `hooks.json`、oh-my-pi 扩展；不轮询 herdr。事件附带 `HERDR_PANE_ID`、`HERDR_TAB_ID`、`HERDR_WORKSPACE_ID`、`TMUX_PANE`。
- 本地上报器 `jfm-emit` 为 POSIX sh + jq + curl：先写 `~/.local/state/job-farm-mon/outbox/`，再 `setsid`（无则 `nohup`）后台批量 POST；hook 20ms 内返回；outbox 上限 500 条。oh-my-pi 扩展进程内 `fetch`，内存重试两次。
- 写 token 每台机器一个，`WRITE_TOKENS="label:token,label2:token2"`，host 标签由 token 决定；读 token 一个 `READ_TOKEN`，登录后下发 HttpOnly 签名 cookie 30 天，也接受 `Authorization: Bearer`。`/api/*` 全部鉴权，静态文件公开，支持 `#token=` 片段首次登录。
- 状态词汇：`idle | working | blocked(permission|question) | done | error | ended`；`stale` 由前端按 `last_event_at` 推算。subagent 折叠进父卡（徽标 + `[AgentType]` 前缀进展行）。
- 固定常量：进展服务端保留 10 条、卡片显示 4 条；stale 阈值 10 分钟；events 去重元数据清理阈值 7 天（非定时 TTL）；ended 默认显示 1 小时、清理阈值 24 小时；乱序宽限 5 秒；迟到 60 秒标“延迟送达”；每 500 次 revision 顺带清理一次；ingest 单批 ≤100 条；标题/摘要 ≤120 字、最后回复 ≤300 字；PreToolUse 同会话 2 秒节流；轮询 3 秒。
- 前端 Preact 11 + @preact/signals + Vite 8，统一轮询 `GET /api/state?since=<rev>`，304 即跳过，页面不可见时暂停；中英双语切换存 localStorage。
- 云端存摘要与会话元数据，events 只保留去重元数据；上报前白名单裁剪工具输入。`JFM_REDACT=1` 清空内容但保留工具名、状态、项目 basename 与会话/主机/model 等标识。
- 版本：TypeScript 5.9.x（不用 7.x）、hono 4.13.14、@hono/node-server 2.1.5、@libsql/client 0.18.0、preact 11.1.0、@preact/signals 2.11.4、vite 8.3.5、wrangler 4.155.0、vitest 5.0.5、@cloudflare/vitest-pool-workers 0.23.0、zod 4.x；Node engines `^24`。
- Cloudflare 用 Durable Object SQLite 而非 D1；DO 内 `storage.sql` 同步调用，`ingest` 以 DO 单线程 + Store 内部异步互斥保证原子。
- 提交信息不得包含 AI 署名行（`~/.claude/settings.json` 的 PreToolUse hook 会拦截）。只在用户要求时提交。

## Implementation tasks

### 阶段 0：脚手架

- [x] T01 初始化仓库与 workspaces
  - 改什么：根 `package.json`（`"workspaces": ["packages/*", "local"]`，scripts：`build`、`typecheck`、`lint`、`test`、`dev:node`、`dev:web`、`dev:cf`、`deploy:cf`），`tsconfig.base.json`（`strict`、`module: NodeNext`/`moduleResolution: bundler` 按包区分）、`eslint.config.js`（照 `/root/github.com/EveGoodEvening/auto-mode-gateway/eslint.config.js` 的 typescript-eslint flat config）、`.gitignore`（`node_modules`、`dist`、`*.sqlite*`、`dev.db*`、`.env*`、`.wrangler`、`.vercel`、`packages/server/public`）、`.nvmrc`（`24`）。
  - 哪里：仓库根。
  - 完成标准：`npm install` 成功；`git branch -M main` 已执行；`npm run typecheck`/`lint`/`test` 在空包上通过。

- [x] T02 建四个 workspace 包骨架
  - 改什么：`packages/core`（`@jfm/core`，`exports` 指向 `dist/index.js` + `dist/index.d.ts`，`build: tsc -p tsconfig.build.json`）、`packages/server`（`@jfm/server`，依赖 `@jfm/core`、hono、@hono/node-server、@libsql/client、zod；devDeps wrangler、tsup、vitest、@cloudflare/vitest-pool-workers、@cloudflare/workers-types）、`packages/web`（`@jfm/web`，preact、@preact/signals、vite、@preact/preset-vite）、`local`（`@jfm/local`，仅 devDeps vitest，用于扩展与脚本测试）。
  - 哪里：各包 `package.json`、`tsconfig.json`。
  - 完成标准：根 `npm run build` 依次构建 core → server → web 成功；server 包能 `import { ... } from '@jfm/core'` 并通过 typecheck。

- [x] T03 仓库文档骨架
  - 改什么：`AGENTS.md`（项目简介、目录说明、`## Lessons` 空段、测试与 heavy-gate 约定）、`README.md` 占位（后续 T40 填充）。
  - 完成标准：两个文件存在，`AGENTS.md` 含 `## Lessons`。

### 阶段 1：真实 payload 采集

- [ ] T10 先写 `jfm-emit` 的记录模式并本机采样
  - 改什么：实现 `local/bin/jfm-emit` 的最小版本：读 stdin、读配置、`JFM_RECORD_DIR` 非空时把 stdin 原文存为 `<agent>-<hook_event_name>-<epoch_ms>.json`，其余功能先 `exit 0`。临时把 `local/claude.hooks.json`、`local/codex.hooks.json`（见 T31、T32）装进本机三份配置（Codex 需 `/hooks` 信任），OMP 扩展先用一个只写文件的临时版本。
  - 采样矩阵（三个 agent 各一轮）：启动、普通 prompt、触发一次权限弹窗、触发一次提问（Claude `AskUserQuestion`、Codex `request_user_input`、OMP `ask`）、完成一轮、启动一个 subagent、`/clear` 或退出。
  - 哪里：样本整理到 `packages/core/test/fixtures/{claude,codex,omp}/<event>.json`，去掉 token 等敏感值，路径可保留。
  - 完成标准：每个 agent 至少覆盖 session_start、prompt、tool_start、blocked/permission、blocked/question、turn_done、subagent_start/stop、session_end 各一份真实样本。
  - 进度（2026-10-29）：Claude/Codex 真实样本已采集并入 fixtures（未采到的少数事件为 `*.synthetic.json`）；OMP 样本未经 hook 采集，扩展用无模型冒烟验证。

- [x] T11 调查 Codex 子 agent 的 hook 字段
  - 做什么：从 T10 样本检查 Codex 子 agent 内 `PreToolUse`/`SessionStart` 是否带 `agent_type`、`agent_id`，以及 `SessionStart.source` 取值。
  - 分支：有 `agent_type` → 进展行前缀用它；只有 `agent_id` → 前缀用 `agent_id` 前 8 位；都没有 → 子 agent 工具事件不加前缀，仅靠 `SubagentStart/Stop` 维护徽标。把结论写进 `AGENTS.md` Lessons。
  - 完成标准：`normalize/codex.ts` 的实现与 Lessons 条目一致。

- [x] T12 调查 oh-my-pi 子 agent 是否与主 agent 同进程
  - 做什么：在临时扩展里于 `session_start` 写模块级变量，在子 agent（`ctx.agent.kind === "sub"`）的 `agent_start` 里读取并打印到文件。
  - 分支：同进程且变量可读 → 子事件用模块级 `rootSessionId` 归入父卡（T33 主路径）；读不到 → 子会话只发 `subagent_start/stop` 到自己的 session id，payload 带 `parentId = ctx.agent.parentId`，服务端 `normalize/omp.ts` 按 `parentId` 映射到父卡（父卡在 `session_start` 时上报自己的 `agent.id`）；仍不可行 → 忽略子事件，父卡靠自身 `tool_execution_start` 显示“正在运行 subagent”。写进 Lessons。
  - 完成标准：T33 的实现与 Lessons 条目一致。

### 阶段 2：core

- [x] T20 类型与信封校验
  - 改什么：`packages/core/src/types.ts`（`AgentKind`、`SessionState`、`BlockedKind`、`Envelope`、`CanonicalEvent` 联合：`session_start | prompt | tool_start | progress | blocked | unblocked | turn_done | error | interrupt | idle_hint | subagent_start | subagent_stop | compact | session_end`，每个都含 `sessionId`，可选 `agentType`、`cwd`）、`packages/core/src/envelope.ts`（zod schema：`v: 1`、`id` 字符串、`ts` 整数、`agent` 枚举、`hostname?`、`pid?`、`env?`、`payload: unknown`；`parseEnvelopes(body)` 接受单个或数组，≤100 条，非法项计入 `ignored`）、`packages/core/src/constants.ts`（Locked decisions 里全部常量）。
  - 完成标准：`envelope.test.ts` 覆盖合法、缺字段、超 100 条三种情况。

- [x] T21 工具摘要函数
  - 改什么：`packages/core/src/summarize.ts` 导出 `summarizeTool(agent, toolName, input): string`：Claude 的 `Bash.command` 首行、`Edit/Write/Read/NotebookEdit.file_path`（相对 cwd）、`Grep/Glob.pattern`、`Agent.description`、`WebFetch.url`、`WebSearch.query`、`Skill.skill`、`AskUserQuestion.questions[0].question`、`ExitPlanMode` → “plan ready for approval”、`mcp__<server>__<tool>` → `server/tool`；Codex 的 `shell|shell_command|exec_command|local_shell` 命令数组 join、`apply_patch` → 变更文件数 + 首个路径、`update_plan` → 首个 in_progress 步骤、`request_user_input` 问题文本、`web_search.query`；OMP 直接使用 `argsPreview`；其余取首个字符串字段；统一截断 120 字并压成单行。
  - 完成标准：`summarize.test.ts` 用 T10 fixture 中的 tool_input 断言输出。

- [x] T22 三个 normalizer
  - 改什么：`packages/core/src/normalize/claude.ts`、`codex.ts`、`omp.ts`、`index.ts`（`normalize(envelope) → CanonicalEvent[]`）。映射严格按 `docs/plan.md` “各 agent 事件映射”表：
    - Claude：`SessionStart`→session_start（cwd、model、source）；`UserPromptSubmit`→prompt；`PreToolUse`→tool_start（有 `agent_id` 则 `agentType = agent_type`），工具为 `AskUserQuestion|ExitPlanMode` 且无 `agent_id` 时再追加 blocked/question；`PostToolUse`→无 `agent_id` 时 unblocked；`PostToolUseFailure`→progress(“✗ <tool> failed”)；`PermissionRequest`→blocked/permission（summarizeTool）；`Notification`：`permission_prompt`→blocked/permission(message)，`idle_prompt`→idle_hint，`agent_needs_input|elicitation_dialog|elicitation_url_dialog`→blocked/question(message)，`elicitation_complete|elicitation_response`→unblocked，其余忽略；`Stop`（无 `agent_id`）→turn_done(last_assistant_message)；`StopFailure`→error；`SubagentStart/Stop`→subagent_start/stop；`PreCompact`→compact；`SessionEnd`→session_end(reason)。
    - Codex：`SessionStart`→session_start；`UserPromptSubmit`→prompt；`PreToolUse`→tool_start，`request_user_input` 再追加 blocked/question；`PostToolUse`→unblocked；`PermissionRequest`→blocked/permission（`tool_input.description` 或 summarizeTool）；`Stop`→turn_done；`Interrupt`→interrupt；`SubagentStart/Stop`→subagent_start/stop；`PreCompact`→compact；`SessionEnd`→session_end。子 agent 前缀按 T11 结论。
    - OMP：按 `payload.type` 直接映射（扩展已发规范化对象，见 T33）；`parentId` 映射按 T12 结论。
  - 完成标准：`normalize.*.test.ts` 用每个 fixture 断言产出的事件数组；未知 `hook_event_name` 返回空数组且不抛错。

- [x] T23 reducer（纯函数）
  - 改什么：`packages/core/src/reducer.ts` 导出 `applyEvent(prev: SessionRow | null, ev, meta: {host, agent, ts, receivedAt, env, hostname}) → {session, progressLine?, changed}`。规则：session_start 新建 idle、已存在未 ended 不改、ended 重开 idle；prompt→working 且 `title` 取首行 120 字；tool_start→working + 进展行 `[agentType] tool: summary`（160 字）；progress 仅追加行；blocked→blocked(kind,msg)；unblocked 仅 blocked→working；turn_done→done 且 `last_message` 300 字；error→error；interrupt→idle 并清 blocked；idle_hint 仅 working→done；subagent_start/stop 维护 `subagents_json`（`{id:{type,since}}`），session_end 清空；compact→进展行“compacting context”；session_end→ended + `ended_at`。`ts` 比 `last_event_at` 早 5 秒以上时只追加进展、不改状态；`last_event_at = min(ts, receivedAt)`；`delayed = receivedAt - ts > 60s`；`project = basename(cwd)`；`state_since` 仅状态变化时更新。
  - 完成标准：`reducer.test.ts` 覆盖每条规则与乱序、重开、idle_hint 容错、subagent 计数。

- [x] T24 SqlDriver 接口与两个驱动
  - 改什么：`packages/core/src/drivers/sql-driver.ts`（`exec(sql, params) → {rows, changes}`、`writeTx(fn(exec) → Promise<T>)`）；`drivers/node-sqlite.ts`（`node:sqlite` `DatabaseSync`，`writeTx` 用 `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`）；`drivers/libsql.ts`（`@libsql/client` `createClient({url, authToken})`，`writeTx` 用 `client.transaction("write")`，`changes` 取 `rowsAffected`）。
  - 完成标准：两个驱动都通过同一组 `driver.contract.test.ts`（建表、插入、`changes`、事务回滚）。

- [x] T25 schema 与 Store
  - 改什么：`packages/core/src/schema.ts`（`meta`、`sessions`、`progress`（`seq INTEGER PRIMARY KEY AUTOINCREMENT`）、`events` 四表 + 索引，`CREATE TABLE IF NOT EXISTS`，`meta.schema_version=3`（迁移删除旧 `events.raw_json`，保留去重 ID 与会话状态））；`packages/core/src/store.ts` 类 `Store(driver)`：`init()`；`ingest(envelopes, host)`：内部 promise 互斥 → `writeTx`：逐条 `INSERT OR IGNORE events`（`changes === 0` 视为重复跳过）→ normalize → applyEvent → upsert sessions → 插进展并裁到 10 条 → 有变化则 `revision+1`；`revision % 500 === 0` 时调用 `purge`；返回 `{accepted, ignored, revision}`；`state({since, endedWithinMs, progressLimit})`：`since === revision` 返回 `null`，否则返回 `{revision, now, sessions[]}`（ended 仅含 `ended_at > now - endedWithinMs`，每会话最近 `progressLimit` 条进展、`subagents` 数组、`delayed`）；`session(key)`：10 条进展 + 完整字段；`purge(now)`：events 超 7 天、ended 超 24 小时及其 progress/events。
  - 完成标准：`store.test.ts` 在 node-sqlite 与 libsql `file:` 两种驱动上参数化运行：revision 递增、重复 id 去重、304 条件、ended 过滤、进展裁剪、purge、并发 ingest（`Promise.all` 10 批）不丢不乱。

### 阶段 3：local（上报器、hook 配置、OMP 扩展、安装脚本）

- [x] T30 `jfm-emit` 完整实现
  - 改什么：`local/bin/jfm-emit`（`#!/bin/sh`）。用法 `jfm-emit <claude|codex|omp>`、`--flush`、`--check`。读 `~/.config/job-farm-mon/config`（`JFM_ENDPOINT`、`JFM_WRITE_TOKEN`、`JFM_DISABLE`、`JFM_REDACT`、`JFM_RECORD_DIR`，环境变量优先）。状态目录 `~/.local/state/job-farm-mon/{outbox,markers,lock.d,record}`。流程：读 stdin → `hook_event_name`/`session_id`/`tool_name` 用 jq 取出 → 节流：`PreToolUse` 且 `markers/<sid>.tool` 内 epoch 与现在差 <2 秒则退出 → blocked 标记：`PermissionRequest`、`Notification`(permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog)、`PreToolUse` 工具 ∈ {AskUserQuestion, ExitPlanMode, request_user_input} 时 `touch markers/<sid>.blocked`；`PostToolUse` 仅在该标记存在或工具 ∈ 提问类时继续并删除标记；`UserPromptSubmit`/`Stop`/`SessionEnd` 删除标记 → 使用白名单最小化 payload（prompt 首个非空行≤120、回复/错误≤300、工具仅摘要所需字段，不发 Write/Edit 内容、patch 正文或未知字段）→ `JFM_REDACT=1` 时用 jq 清空 `tool_input`（保留 `tool_name`）、`prompt`、`last_assistant_message`、`message` → 组装信封（`id` 用 `uuidgen`，缺则 `date +%s%N` + `$$` + `od -An -N4 -tx1 /dev/urandom`；`ts` 毫秒，macOS 无 `%N` 时 `%s000`；`hostname`、`pid`、`env` 四个变量）→ 原子写 `outbox/<ts>-<rand>.json` → `setsid -f sh "$0" --flush`，无 `setsid` 则 `nohup sh "$0" --flush >/dev/null 2>&1 </dev/null &`。`--flush`：`JFM_DISABLE=1` 时直接返回且不改动队列；否则 `mkdir lock.d` 抢锁（锁目录 >60 秒视为过期删除）；每轮取最旧 100 个文件 用与入队相同的 sanitizer 重做最小化/当前 redaction 后成数组，curl 经 fd 3 配置传 token（不放 argv）；2xx 删除这批，401/403 记录到 `emit.log` 后停止，其他失败停止留待下次；超过 500 个时删最旧。`--check`：POST `[]` 并打印状态码与返回体。所有路径在 1 秒内返回。
  - 完成标准：`local/test/emit.test.mjs`（`node --test`，用 `local/test/mock-server.mjs` 起本地 HTTP）覆盖：正常投递、服务器 500 时 outbox 保留并在下次调用成功冲刷、401 停止、500 条上限、2 秒节流、blocked 标记控制 PostToolUse、`JFM_REDACT=1` 清空字段、`--check` 输出、`sh -n` 语法检查、单次调用耗时 <1 秒（在 dash 与 bash 下各跑一次）。

- [ ] T31 Claude hook 配置片段
  - 改什么：`local/claude.hooks.json`：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`Notification`、`Stop`、`StopFailure`、`SubagentStart`、`SubagentStop`、`PreCompact` 各一个无 matcher 的组，hook 为 `{"type":"command","command":"~/.local/bin/jfm-emit claude","async":true,"timeout":5}`；`SessionEnd` 为同步 `{"type":"command","command":"~/.local/bin/jfm-emit claude","timeout":3}`。
  - 完成标准：`claude --debug` 启动一次，日志里 13 个事件的 hook 都注册成功且无 schema 报错。
  - 进度：片段已合并验证（临时 HOME + `claude -p --settings` 端到端收到事件）；`claude --debug` 注册检查未在真实配置上执行。

- [ ] T32 Codex hook 配置片段
  - 改什么：`local/codex.hooks.json`：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、`Stop`、`SubagentStart`、`SubagentStop`、`PreCompact` 的组用 `{"type":"command","command":"~/.local/bin/jfm-emit codex","async":true,"timeout":5,"statusMessage":"job-farm-mon"}`；`SessionEnd` 与 `Interrupt` 用同步 `{"type":"command","command":"~/.local/bin/jfm-emit codex","timeout":1}`。
  - 完成标准：合并进 `~/.codex/hooks.json` 后，Codex 内 `/hooks` 能列出并信任全部条目，`config.toml` 的 `[hooks.state]` 新增对应 `trusted_hash`。
  - 进度：片段已写好并在隔离 CODEX_HOME 中验证可触发；合并进真实 `~/.codex/hooks.json` 后需用户在 Codex 里 `/hooks` 信任。

- [x] T33 oh-my-pi 扩展
  - 改什么：`local/omp/job-farm-mon.ts`（`// @ts-nocheck` 风格同 herdr 扩展，`export default function (pi)`）。启动时读配置文件（`$XDG_CONFIG_HOME` 或 `~/.config/job-farm-mon/config`），缺失或 `JFM_DISABLE=1` 直接 return。模块级 `rootSessionId`、`rootAgentId`、队列（串行、失败重试 2 次、超时 3 秒）。事件 → 信封 `payload`（`agent: "omp"`，`payload.type` 用规范事件名）：`session_start`→`session_start`（`sessionId=ctx.sessionManager.getSessionId()`、`cwd=ctx.cwd`（redaction 时仅 basename）、`hasUI`、`agentId=ctx.agent.id`）；`session_switch`→旧 id `session_end(reason="switch")` + 新 id `session_start`；`before_agent_start`（main）→`prompt`（首个非空行≤120 字）；`tool_execution_start`→`ask` 时 `blocked/question`（`args.questions[0].question`），否则 `tool_start`（`toolName` + `argsPreview`：依次取 `command|path|file_path|pattern|description|question|query|url` 首个字符串，120 字）；`tool_execution_end` 且 `ask`→`unblocked`；`tool_approval_requested`→`blocked/permission`（`reason || toolName`）；`tool_approval_resolved`→`unblocked`；`plan_review_requested`→`blocked/question("plan review")`；`plan_review_resolved`→`unblocked`；`auto_retry_start`→`tool_start(tool="retry")`；`session_before_compact`→`compact`；`agent_end`（main，`willContinue !== true`）→最后 assistant 消息 `stopReason === "error"` 时 `error(errorMessage || partial reply)`（`JFM_REDACT=1` 时为空），否则 `turn_done(text 300 字)`；`session_shutdown`→`session_end`，等待队列最多 2 秒。子 agent（`ctx.agent.kind === "sub"`）：按 T12 结论归属，`agent_start`→`subagent_start(agentId=ctx.agent.id, agentType=ctx.agent.name)`，`agent_end`→`subagent_stop`，工具事件带 `agentType`，不发 `prompt`/`turn_done`。
  - 完成标准：`local/test/omp-extension.test.ts`（vitest）用假 `pi`/`ctx` 驱动上述每条路径并断言 `fetch` 收到的信封；`session_shutdown` 后无未决请求。

- [x] T34 安装 / 卸载脚本
  - 改什么：`local/install.sh`（bash）：参数 `--endpoint URL`、`--token T`、`--uninstall`、`--purge`、`--no-claude`、`--no-codex`、`--no-omp`。步骤：检查 `jq`、`curl`（缺失则报错并给 `apt install jq` / `brew install jq` 提示）→ 写 `~/.config/job-farm-mon/config`（0600，已存在且未传参则保留，tty 下缺参交互询问）→ `install -m 755 local/bin/jfm-emit ~/.local/bin/jfm-emit` → Claude：`~/.claude/settings.json`（缺则 `{}`）备份为 `settings.json.bak-jfm`，用 `local/merge-hooks.jq` 合并：对片段里每个事件，先过滤掉任一 hook `command` 含 `jfm-emit` 的旧组，再把新组 append 到末尾；临时文件 + `mv` 原子替换 → Codex：`~/.codex/hooks.json`（缺则 `{"hooks":{}}`）同法合并，并检查 `~/.codex/config.toml` 是否含 `hooks = true`，否则打印提示 → OMP：`install -m 644 local/omp/job-farm-mon.ts ~/.omp/agent/extensions/job-farm-mon.ts` → 打印后续步骤：Codex 里运行 `/hooks` 信任、重启各 agent、`jfm-emit --check`。`--uninstall`：移除三处条目与扩展，`--purge` 再删配置与状态目录。
  - 完成标准：`local/test/install.test.mjs` 用临时 `HOME` 运行：全新安装、重复安装不产生重复条目、不破坏已有 heavy-gate/herdr 条目（用本机三份配置的脱敏副本做 fixture）、卸载后文件回到原样。

### 阶段 4：server

- [x] T40 鉴权模块
  - 改什么：`packages/server/src/auth.ts`：`parseWriteTokens(env)`（`label:token,...` → `Map<token,label>`）、`constantTimeEqual`（对两者 SHA-256 后逐字节 XOR）、`findWriteHost(authHeader)`、`makeReadCookie(readToken, exp)` / `verifyReadCookie(value)`（Web Crypto HMAC-SHA256，密钥由 `READ_TOKEN` + 固定盐 `jfm-cookie-v1` 派生，值 `<exp>.<base64url(mac)>`，30 天）、`isReadAuthed(c)`（cookie `jfm_s` 或 `Authorization: Bearer <READ_TOKEN>`）。
  - 完成标准：`auth.test.ts` 覆盖正确/错误 token、过期 cookie、篡改 cookie、空 `WRITE_TOKENS`。

- [x] T41 Hono app 工厂与路由
  - 改什么：`packages/server/src/backend.ts`（`StateBackend { ingest, state, session }`、`LocalBackend(store)`）；`packages/server/src/app.ts` 导出 `createApp(resolve: (c) => Runtime)`，`Runtime = { backend, readToken, writeTokens, version, driverName, secureCookies }`：`GET /api/health`（公开）；`POST /api/login`（body `{token}`，失败 `await sleep(300)` 后 401，成功 204 + `Set-Cookie: jfm_s=...; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` 加 `Secure` 当请求为 https）；`POST /api/logout`；`GET /api/me`（204/401）；`GET /api/state?since=&ended=1h|24h`（读鉴权，`null` → 304，否则 JSON 并带 `Cache-Control: no-store`）；`GET /api/sessions/:key`（读鉴权，key 需 `decodeURIComponent`）；`POST /api/ingest`（写鉴权 → host 标签，body 单个或数组，`parseEnvelopes`，>100 条 413，返回 `{accepted, ignored, revision}`）；未匹配的 `/api/*` 404 JSON。
  - 完成标准：`packages/server/test/app.test.ts` 用 node-sqlite `:memory:` 的 `LocalBackend` 通过 `app.request()` 覆盖所有路由、鉴权失败分支、304 分支、ended 参数、413。

- [x] T42 Cloudflare 入口与 Durable Object
  - 改什么：`packages/server/src/drivers/do-sqlite.ts`（包装 `ctx.storage.sql.exec(sql, ...params)`：`rows = cursor.toArray()`，`changes = cursor.rowsWritten`；`writeTx(fn)` 直接执行 fn，并在文件头注释说明依赖 DO 单线程与 Store 互斥）；`packages/server/src/entry.cloudflare.ts`：`export class JfmStore extends DurableObject<Env>`（构造时 `new Store(doDriver)` 并 `ctx.blockConcurrencyWhile(() => store.init())`，RPC `ingest(envs, host)`、`state(opts)`、`session(key)`），`DoBackend(stub)`，`createApp(c => runtime(c.env))` 用 `WeakMap` 按 env 缓存，`env.STORE.idFromName("main")`；`export default { fetch }`；`packages/server/wrangler.jsonc`：`name: job-farm-mon`、`main: src/entry.cloudflare.ts`、`compatibility_date` 取当日、`durable_objects.bindings [{name:"STORE", class_name:"JfmStore"}]`、`migrations [{tag:"v1", new_sqlite_classes:["JfmStore"]}]`、`assets {directory:"../web/dist", binding:"ASSETS", not_found_handling:"single-page-application", run_worker_first:["/api/*"]}`、`observability.enabled: true`；`vars` 留空，密钥用 `wrangler secret put READ_TOKEN` / `WRITE_TOKENS`。
  - 调查分支：若当前 wrangler schema 拒绝 `run_worker_first` 数组，则去掉该字段，在 Worker 内先匹配 `/api/*` 再 `return env.ASSETS.fetch(request)`。
  - 完成标准：`packages/server/test/worker.test.ts`（`@cloudflare/vitest-pool-workers`）：ingest 两批 → `/api/state` 返回会话 → 带 `since` 返回 304 → 错误 token 401；`wrangler dev --local` 能起、`/api/health` 返回 `driver: "do-sqlite"`。

- [x] T43 Node（Railway）入口与容器
  - 改什么：`packages/server/src/entry.node.ts`：DB 路径 `process.env.JFM_DB_PATH ?? join(process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "./data", "jfm.sqlite")`，`mkdirSync(dirname, {recursive:true})`，`Store(nodeSqliteDriver)`，`createApp` 常量 runtime，`serveStatic({root: <web/dist>})` 处理非 `/api` GET 并对无扩展名路径回退 `index.html`，`serve({fetch, port: Number(process.env.PORT ?? 8787)})`，启动时 `await store.init()`；`packages/server/tsup.config.ts` 打包 `entry.node.ts`（bundle `@jfm/core`，external `node:sqlite`）；根 `Dockerfile`：`node:24-alpine` 两阶段（`npm ci` → `npm run build` → 生产阶段 `npm ci --omit=dev` + 复制 `packages/server/dist`、`packages/web/dist`），`ENV PORT=8080`，`CMD ["node","packages/server/dist/entry.node.js"]`；`railway.json`：`{"build":{"builder":"DOCKERFILE"},"deploy":{"healthcheckPath":"/api/health","restartPolicyType":"ON_FAILURE"}}`。
  - 完成标准：`docker build` 成功；`docker run -e READ_TOKEN=.. -e WRITE_TOKENS=.. -v $(pwd)/tmpdata:/data -p 8080:8080` 后 `curl /api/health` 返回 `driver: "node-sqlite"`，重启容器后会话仍在。

- [x] T44 Vercel 入口
  - 改什么：`packages/server/src/entry.vercel.ts`（`Store(libsqlDriver(createClient({url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN})))`，`init()` 懒执行一次并缓存 promise，`export default createApp(...)`）；`packages/server/src/index.ts` 仅 `export { default } from "./entry.vercel.js"`；`packages/server/vercel.json`：`{"$schema":"https://openapi.vercel.sh/vercel.json","framework":"hono","installCommand":"cd ../.. && npm ci","buildCommand":"cd ../.. && npm run build && cp -r packages/web/dist/. packages/server/public/"}`；根 `package.json` 加 `build:vercel` 别名。README 写明 Vercel 项目 Root Directory 设为 `packages/server`。
  - 调查分支：若 `vercel build`（本地可用 `npx vercel build` 不登录验证打包）或首次部署显示 Hono 预设不识别该入口，则改为 `packages/server/api/index.ts` 导出 `handle(app)`（`@hono/vercel`），`vercel.json` 去掉 `framework`，加 `"rewrites":[{"source":"/api/(.*)","destination":"/api"}]`，静态文件仍放 `public/`。把结论写进 Lessons。
  - 完成标准：`TURSO_DATABASE_URL=file:./dev.db` 时用 `@hono/node-server` 包一层本地跑通 `app.test.ts` 同一组用例（`packages/server/test/vercel-entry.test.ts`）；`npx vercel build` 在本机成功产出 `.vercel/output`。

### 阶段 5：web

- [x] T50 Vite + Preact 骨架与 API 客户端
  - 改什么：`packages/web/index.html`、`vite.config.ts`（`@preact/preset-vite`，`server.proxy` 把 `/api` 转到 `http://127.0.0.1:8787`，`build.outDir: dist`）、`src/main.tsx`、`src/api.ts`（`login(token)`、`me()`、`fetchState(since)` 处理 200/304/401、`fetchSession(key)`）、`src/state.ts`（signals：`sessions`、`revision`、`serverOffsetMs = now - Date.now()`、`authed`、`lang`、`hostFilter`、`showEnded`）、轮询器：3 秒间隔，`document.visibilityState !== "visible"` 时停止并在恢复时立即拉一次，401 时切到登录页；加载时若 `location.hash` 匹配 `#token=` 则先 `login` 再 `history.replaceState` 清掉。
  - 完成标准：`vite build` 产物 ≤150 KB gzip；本地对接 T43 的 node 入口能登录并拉到状态。

- [x] T51 i18n 与时间格式
  - 改什么：`src/i18n.ts`（zh/en 字典：状态名、分区标题、“无更新 Xm / no update for Xm”、“延迟送达 / delayed”、登录文案、按钮；`t(key)` 跟随 `lang` signal；持久化 `localStorage["jfm.lang"]`，默认按 `navigator.language` 以 zh 开头选中文）；`src/time.ts`（`relative(ts)`：秒/分/小时/天两级精度，`elapsed(stateSince)`；用 `serverOffsetMs` 校正；10 秒一次 tick signal）。
  - 完成标准：`i18n.test.ts`、`time.test.ts`（vitest + jsdom 可免）覆盖两种语言和边界值。

- [x] T52 组件与布局
  - 改什么：`src/components/TopBar.tsx`（host 筛选 chips、各状态计数、连接状态点、语言切换、显示已结束开关）、`Section.tsx`、`SessionCard.tsx`、`Login.tsx`、`src/app.tsx`。分区顺序：等待处理（blocked，permission 与 question 同区）→ 进行中（working；`now - last_event_at > 10min` 的标 stale 并排最前）→ 完成/空闲（done、error、idle）→ 已结束（折叠，默认 1 小时内，开关打开请求 `ended=24h`）。卡片头部一行：状态点、agent 图标（C/X/π 三个字母徽标即可）、`project`、host chip、`title`、`relative(last_event_at)`；进行中卡体：4 条进展各带相对时间，`subagents` 非空时徽标“↳ N：types”；blocked 卡体：kind 标签 + `state_msg`；done 卡体：`last_message` 两行 `line-clamp`；error：`last_message`；`delayed` 时加小标签。点击卡片展开：请求 `/api/sessions/:key`，显示 10 条进展、完整 `last_message`、`cwd`、`session_id`、`herdr_pane_id`、`started_at`。
  - 完成标准：用 T10 fixture 灌进本地 node 入口后，页面同时出现四个分区且排序符合规则；手机宽度（375px）单列无横向滚动；深浅色都可读。

- [ ] T53 样式
  - 改什么：`src/styles.css`：`:root` 颜色 token，`@media (prefers-color-scheme: dark)` 覆盖；状态色：blocked 红、working 琥珀、done 绿、idle 灰、error 深红、ended 淡灰；stale 琥珀边框；系统字体栈；16px 侧边距。
  - 完成标准：Lighthouse 无对比度告警（手动 devtools 检查即可）。
  - 进度：样式完成，四张截图目测深浅色可读；Lighthouse 对比度检查未执行。

### 阶段 6：文档与收尾

- [x] T60 README
  - 改什么：`README.md`：架构图（复用 plan）、三平台部署步骤（Cloudflare：`npx wrangler login` → `wrangler secret put READ_TOKEN` / `WRITE_TOKENS` → `npm run deploy:cf`；Railway：`railway login` → 新服务指向仓库、Dockerfile 构建、添加 Volume 挂 `/data`、设置 `READ_TOKEN`/`WRITE_TOKENS`；Vercel：`vercel login` → Root Directory `packages/server` → Turso 建库拿 `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` → 环境变量 → `vercel deploy`）、token 生成 `openssl rand -hex 24`、每台机器安装 `local/install.sh --endpoint ... --token ...`、Codex `/hooks` 信任、排障（`jfm-emit --check`、outbox 路径、`emit.log`、`/api/health`）、免费额度估算、`JFM_REDACT`。
  - 完成标准：按 README 从零走一遍 Cloudflare 路径（用户登录后）无需查代码。

- [x] T61 开发脚本
  - 改什么：根 scripts：`dev:node`（`tsx watch packages/server/src/entry.node.ts`，`JFM_DB_PATH=./data/dev.sqlite`）、`dev:web`（`vite`）、`dev:cf`（`wrangler dev`）、`seed`（`scripts/seed.mjs` 把 `packages/core/test/fixtures` 按时间顺序 POST 到本地 `/api/ingest`）。
  - 完成标准：三个 dev 命令都能起并被 `seed` 灌数据。

- [x] T62 Lessons 与记忆回写
  - 改什么：把 T11、T12、T42、T44 的调查结论和实现中踩到的版本坑写进 `AGENTS.md` 的 `## Lessons`。
  - 完成标准：每个调查任务在 Lessons 中有一条可复用结论。

## Validation

- [x] V01 `npm run typecheck && npm run lint && npm test` 在根目录全部通过（core、server、web、local 四个 workspace）。
- [x] V02 core：normalizer 测试覆盖 T10 全部 fixture；reducer 测试覆盖每条规则；store 测试在 node-sqlite 与 libsql `file:` 两驱动上通过；`driver.contract.test.ts` 两驱动通过。
- [x] V03 server：`app.test.ts`（LocalBackend）、`vercel-entry.test.ts`（libsql file）、`worker.test.ts`（vitest-pool-workers，DO 驱动）全部通过；`wrangler dev --local` 下 `/api/health`、登录、ingest、304 手工 curl 验证。
- [ ] V04 local：`emit.test.mjs` 在 `sh`（dash）与 `bash` 下通过，单次调用 <1 秒；`install.test.mjs` 幂等与卸载通过；`omp-extension.test.ts` 通过；`shellcheck local/bin/jfm-emit local/install.sh` 无 error 级问题。
  - 进度：dash/bash 测试、install 幂等/卸载、omp 扩展测试均通过；shellcheck 未安装，未执行。
- [ ] V05 本机端到端矩阵：用 `install.sh` 装到本机真实配置，后端用 `wrangler dev --local`（再各换 node 入口、libsql 入口跑一轮）。对 Claude Code、Codex、oh-my-pi 各执行：提交 prompt → 卡片 5 秒内变 working 且标题为 prompt 首行；触发权限弹窗 → blocked/permission 置顶并显示命令摘要；批准后 → working；触发提问 → blocked/question 显示问题；回答后 → working；完成 → done 显示回复摘要；启动 subagent → 徽标出现并随结束消失；`kill -9` 该 agent → 10 分钟后出现 stale 标记（测试时可把前端阈值临时改小）；正常退出 → 进入已结束分区并在 1 小时后隐藏。
  - 进度：自动化部分已完成（install.sh 装到临时 HOME + 真实 `claude -p` → node 入口，卡片含标题/进展/回复）。三个 agent 的交互式矩阵（授权、提问、kill -9 stale）需人工执行。
- [x] V06 浏览器检查：用 `~/.claude/bin/heavy-gate -n 1 -- node scripts/screenshot.mjs` 后台运行 Playwright（`--workers=1`，单浏览器，`finally` 关闭）截 375px 与 1280px、深浅色四张图，确认分区顺序、4 行进展、line-clamp、无横向滚动。
- [x] V07 Docker：`docker build` + 本地运行 Railway 镜像，重启后数据仍在，`/api/health` 正常。
- [x] V08 `npx vercel build` 本地成功；若触发 T44 分支则按分支结论重新验证。
- [ ] V09 部署冒烟（用户登录后执行）：三个平台各部署一次，`/api/health` → 登录 → `jfm-emit --check` 返回 200 → 真实 agent 事件出现在页面 → 304 轮询在 Network 面板可见。
  - 进度：需要用户登录 wrangler/railway/vercel 后执行。
- [x] V10 安全复核：`WRITE_TOKENS`/`READ_TOKEN` 不出现在任何日志、响应或仓库文件；cookie 为 HttpOnly + SameSite=Lax（https 下带 Secure）；错误 token 对 `/api/state`、`/api/sessions/:key`、`/api/ingest` 均 401；`JFM_REDACT=1` 时不发命令、问题、回复或错误文本，cwd 仅保留项目 basename；session/host/model/terminal 等元数据仍保留。
- [x] V11 代码评审：实现完成后跑一次 `/code-review` 覆盖 core 的 reducer/store 与 `jfm-emit`，修复高置信度问题后再做 V05。

## Privacy fixes (2026-10-29)

- [x] OMP 终态错误（errorMessage 与 partial reply fallback）遵守 `JFM_REDACT`；redaction 时 cwd 仅项目 basename，prompt 只发首个非空行≤120 字。
- [x] `jfm-emit` 入队和上传共用白名单投影，不上传文件正文、patch 正文、未知字段或 prompt 后续行；旧队列按当前 redaction 重新处理。`JFM_DISABLE=1 --flush` 不请求网络、不改动队列，启用后可恢复。
- [x] schema v3 删除 `events.raw_json`，v1/v2 升级保留去重 ID、session/progress；新事件只持久化去重元数据。
- [x] 隔离临时 HOME + 真实 loopback HTTP + Node/SQLite 冒烟验证上述边界及旧 ID 去重；core 235、server 107、OMP 20、shell/install 61、Cloudflare/workerd 24 条回归通过（含 DO 旧 raw_json 迁移）；所有 workspace 类型检查（含 pure/worker）及 lint 通过。
- 升级需重新部署服务、重装本地 reporter 并重启 agent。不会改写已存的本地旧队列、raw 录制、备份，也不承诺物理擦除；配置不热加载，不取消已在运行的 flush 或请求。
