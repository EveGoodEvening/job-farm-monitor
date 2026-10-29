# Hook payload fixtures

Layout: `<agent>/<HookEvent>[.<variant>][.synthetic].json`, one payload per file.

## Real captures (`claude/`, `codex/`)

Everything in `claude/` and `codex/` that does NOT end in `.synthetic.json` is a
real hook stdin payload recorded during T10/T11 on 2026-10-29:

- Claude Code 2.1.312 (headless `claude -p` and one interactive session).
- Codex CLI 0.165.0 (interactive app with an isolated `CODEX_HOME`, plus `codex exec`).

The captures were pretty-printed and scrubbed; nothing else was changed:

- absolute scratch paths were rewritten to neutral ones: the working directory
  is `/home/user/proj`, Claude's home is `/home/user/.claude` (project slug
  `-home-user-proj`), Codex's home is `/home/user/.codex`;
- Codex `collaborationspawn_agent.tool_input.message` is an encrypted blob and
  was truncated (`gAAAA...(encrypted, truncated)`);
- `tool_response` was kept (Claude: object; Codex: always a string). Note that
  `jfm-emit` drops `tool_response` before sending, so normalizers never see it.
  The Codex spawn response `{"task_name":"/root/cat_hello"}` is Codex's own
  agent-tree path, not a filesystem path.

Session ids, tool-use ids and agent ids are the real (random) ones. Useful facts
the captures show (see also docs/plan.md):

- Claude `SessionStart.model` is present only on interactive startup
  (`SessionStart.json`); it is absent headless and on `source: "clear"`.
- Claude AskUserQuestion fires PreToolUse, then `PermissionRequest` with
  `tool_name: "AskUserQuestion"`, then `Notification(permission_prompt)`.
- Claude can send a `SubagentStop` with `agent_type: ""` and no matching
  `SubagentStart` (`SubagentStop.no_start.json`).
- Codex subagent tool hooks carry the parent `session_id` plus `agent_id`
  (child thread UUID) and `agent_type` (usually `"default"`).
- Codex tool names: `Bash`, `collaborationspawn_agent`, `collaborationwait_agent`,
  `clocksleep`, `request_user_input` (Plan mode), `request_user_input_async`
  (Default mode; its PostToolUse fires immediately with `{"accepted":true}` and
  the answer arrives as a `UserPromptSubmit` starting with
  `<send_user_message_question_reply>`).
- Codex interactive sessions never send `SessionEnd` on `/exit` or `/clear`
  (`SessionEnd.json` comes from `codex exec`).

## Synthetic (`*.synthetic.json`)

These events were not captured (they need an API error, a long context, MCP
elicitation or plan mode). They are hand-written from the documented hook
schema, reusing the ids/paths of the real sessions:

| File | Why synthetic |
|---|---|
| `claude/StopFailure.synthetic.json` | needs an API error; the error field name (`error`) is a guess |
| `claude/PreCompact.synthetic.json` | needs a long context |
| `claude/Notification.agent_needs_input.synthetic.json` | not observed |
| `claude/Notification.elicitation_dialog.synthetic.json` | needs MCP elicitation |
| `claude/PreToolUse.ExitPlanMode.synthetic.json` | needs plan mode |
| `codex/PreCompact.synthetic.json` | needs a long context |

## omp (`omp/`)

Already-canonical `OmpPayload` objects as emitted by the omp extension (T33):
`{ "type": <canonical event>, "sessionId", ... }`. They are hand-written to the
extension's output format (the extension itself is tested in `local/test`).
