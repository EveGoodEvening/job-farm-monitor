// job-farm-mon reporter for oh-my-pi (tested against 18.13.3).
// Installed by job-farm-mon `local/install.sh` to ~/.omp/agent/extensions/job-farm-mon.ts;
// reinstalling overwrites this file.
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-explicit-any -- omp hands us untyped event/ctx objects; this file is loaded by omp (Bun) without our types */
//
// Reports canonical job-farm-mon events (docs/contracts.md section 2, `OmpPayload`)
// straight to `${JFM_ENDPOINT}/api/ingest` with in-process `fetch`: a serial
// in-memory queue, batches of <= 100, 2 retries, 3 s per request, and a 2 s
// drain on session_shutdown. Config: `$XDG_CONFIG_HOME/job-farm-mon/config`
// (default ~/.config/job-farm-mon/config), sh `KEY=value` lines; environment
// variables win. Missing endpoint/token or JFM_DISABLE=1 -> the extension
// registers nothing.
//
// Subagents (T12 conclusion): oh-my-pi runs task/eval subagents IN THE SAME
// PROCESS via createAgentSession and re-invokes this factory for each child
// session (`ctx.agent.kind === "sub"`). Normal task spawns rebind the already
// imported factory (same module instance), but isolated/worktree tasks and
// `/reload` re-import the file with a `?mtime=` cache-buster, which creates a
// FRESH module instance. Plain module-level variables are therefore not
// reliable, so the root-session registry lives on `globalThis` under a
// `Symbol.for` key: every agent id maps to the root (main) session id, and a
// subagent resolves its root through `ctx.agent.parentId` (nested subagents
// chain through their parent's entry). Subagent events are reported on the
// root session id with `agentType = ctx.agent.name`. Only if no root can be
// resolved (should not happen in-process) does the fallback branch send
// `subagent_start/stop` on the subagent's own session id with `parentId`.

import { readFileSync } from "node:fs";
import { hostname as osHostname, homedir } from "node:os";
import { join } from "node:path";

// Mirrors of @jfm/core constants (this file is installed standalone and cannot
// import workspace packages). Keep in sync with packages/core/src/constants.ts.
const OMP_RETRIES = 2;
const OMP_TIMEOUT_MS = 3_000;
const OMP_SHUTDOWN_WAIT_MS = 2_000;
const INGEST_MAX_BATCH = 100;
const OUTBOX_MAX = 500;
const TOOL_THROTTLE_MS = 2_000;
const SUMMARY_MAX = 120;
const PROMPT_MAX = 200;
const LAST_MESSAGE_MAX = 300;
const STATE_MSG_MAX = 300;
const RETRY_BACKOFF_MS = 250;

const PREVIEW_KEYS = ["command", "path", "file_path", "pattern", "description", "question", "query", "url"];
const GLOBAL_KEY = Symbol.for("job-farm-mon.omp.registry");

// ---------------------------------------------------------------------------
// Process-wide registry (shared across module instances, see header)
// ---------------------------------------------------------------------------

type Registry = {
  /** agent id (ctx.agent.id) -> root (main) session id */
  agents: Map<string, string>;
  /** most recent main session id in this process */
  lastRoot: string | undefined;
  /** root session id -> last tool_start epoch ms (throttle) */
  lastTool: Map<string, number>;
};

function registry(): Registry {
  let reg = globalThis[GLOBAL_KEY];
  if (!reg) {
    reg = { agents: new Map(), lastRoot: undefined, lastTool: new Map() };
    globalThis[GLOBAL_KEY] = reg;
  }
  return reg;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Config = { endpoint: string; token: string; redact: boolean };

function parseConfigFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}

function configPath(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(env.HOME || homedir(), ".config");
  return join(base, "job-farm-mon", "config");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config | null {
  let file: Record<string, string> = {};
  try {
    file = parseConfigFile(readFileSync(configPath(env), "utf8"));
  } catch {
    file = {};
  }
  const get = (k: string): string => {
    const v = env[k];
    return v !== undefined && v !== "" ? v : (file[k] ?? "");
  };
  if (get("JFM_DISABLE") === "1") return null;
  const endpoint = get("JFM_ENDPOINT").replace(/\/+$/, "");
  const token = get("JFM_WRITE_TOKEN");
  if (!endpoint || !token) return null;
  return { endpoint, token, redact: get("JFM_REDACT") === "1" };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function oneLine(text: unknown, max: number): string {
  const s = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return clip(s, max);
}

/** First string among command|path|file_path|pattern|description|question|query|url. */
export function argsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return typeof args === "string" ? oneLine(args, SUMMARY_MAX) : "";
  for (const k of PREVIEW_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return oneLine(v, SUMMARY_MAX);
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
      return oneLine(v.join(" "), SUMMARY_MAX);
    }
  }
  if (Array.isArray(args.questions)) return oneLine(askQuestion(args), SUMMARY_MAX);
  return "";
}

function askQuestion(args: unknown): string {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const first = questions.find((q) => typeof q?.question === "string" && q.question.trim());
  if (first) return first.question;
  if (typeof args?.question === "string" && args.question.trim()) return args.question;
  return "waiting for user input";
}

function lastAssistant(messages: unknown): any {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function assistantText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function sessionIdOf(ctx: any): string | undefined {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

type AgentIdentity = { kind: "main" | "sub"; id: string; name: string; parentId?: string };

function agentOf(ctx: any): AgentIdentity {
  const a = ctx?.agent;
  const kind = a?.kind === "sub" ? "sub" : "main";
  return {
    kind,
    id: typeof a?.id === "string" && a.id ? a.id : kind === "main" ? "Main" : "sub",
    name: typeof a?.name === "string" && a.name ? a.name : kind === "main" ? "main" : "sub",
    parentId: typeof a?.parentId === "string" && a.parentId ? a.parentId : undefined,
  };
}

function envIds(env: Record<string, string | undefined>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const map = {
    herdr_pane_id: "HERDR_PANE_ID",
    herdr_tab_id: "HERDR_TAB_ID",
    herdr_workspace_id: "HERDR_WORKSPACE_ID",
    tmux_pane: "TMUX_PANE",
  };
  for (const [k, name] of Object.entries(map)) {
    const v = env[name];
    if (typeof v === "string" && v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// ---------------------------------------------------------------------------
// Sender: serial in-memory queue with retries (one per module instance)
// ---------------------------------------------------------------------------

function createSender(config: Config) {
  const url = `${config.endpoint}/api/ingest`;
  const queue: unknown[] = [];
  let draining: Promise<void> | null = null;
  let inflight: AbortController | null = null;
  let aborted = false;

  async function post(batch: unknown[]): Promise<"ok" | "drop" | "retry"> {
    const controller = new AbortController();
    inflight = controller;
    const timer = setTimeout(() => controller.abort(), OMP_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });
      try {
        await res.body?.cancel?.();
      } catch {
        // ignore
      }
      if (res.status >= 200 && res.status < 300) return "ok";
      if (res.status === 429 || res.status >= 500) return "retry";
      return "drop"; // 400/401/403/413: retrying cannot help
    } catch {
      return "retry";
    } finally {
      clearTimeout(timer);
      if (inflight === controller) inflight = null;
    }
  }

  async function sendBatch(batch: unknown[]): Promise<void> {
    for (let attempt = 0; attempt <= OMP_RETRIES && !aborted; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt);
      if (aborted) return;
      const r = await post(batch);
      if (r !== "retry") return;
    }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0 && !aborted) {
      await sendBatch(queue.splice(0, INGEST_MAX_BATCH));
    }
  }

  function kick(): void {
    if (draining || aborted) return;
    draining = drain().finally(() => {
      draining = null;
      if (queue.length > 0 && !aborted) kick();
    });
  }

  return {
    enqueue(envelope: unknown): void {
      if (aborted) aborted = false; // a new session after a shutdown in the same process
      queue.push(envelope);
      if (queue.length > OUTBOX_MAX) queue.splice(0, queue.length - OUTBOX_MAX);
      kick();
    },
    /** Wait for the queue to drain, at most `ms`; then abort whatever is left. */
    async flush(ms: number): Promise<void> {
      if (draining) {
        let timer;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
          timer.unref?.();
        });
        await Promise.race([draining, timeout]);
        clearTimeout(timer);
      }
      if (draining || queue.length > 0) {
        aborted = true;
        queue.length = 0;
        inflight?.abort();
        await draining?.catch(() => {});
      }
    },
    pending(): number {
      return queue.length + (draining ? 1 : 0);
    },
  };
}

// ---------------------------------------------------------------------------
// Extension factory (invoked once per session, main and sub)
// ---------------------------------------------------------------------------

let moduleSender: ReturnType<typeof createSender> | null = null;
let moduleSenderKey = "";

export default function jobFarmMon(pi: any): void {
  const env = process.env;
  const config = loadConfig(env);
  if (!config) return;

  const key = `${config.endpoint}\n${config.token}`;
  if (!moduleSender || moduleSenderKey !== key) {
    moduleSender = createSender(config);
    moduleSenderKey = key;
  }
  const sender = moduleSender;
  const reg = registry();
  const host = (() => {
    try {
      return osHostname();
    } catch {
      return undefined;
    }
  })();
  const ids = envIds(env);

  // Per-session (per factory invocation) state.
  let mainSessionId: string | undefined; // main: the session id we reported session_start for
  let subStarted = false; // sub: subagent_start sent and not yet stopped
  let subRootSessionId: string | undefined;
  let subOwnSessionId: string | undefined;

  function emit(payload: Record<string, unknown>): void {
    const envelope: Record<string, unknown> = {
      v: 1,
      id: newId(),
      ts: Date.now(),
      agent: "omp",
      payload,
    };
    if (host) envelope.hostname = host;
    envelope.pid = process.pid;
    if (ids) envelope.env = ids;
    sender.enqueue(envelope);
  }

  /** Make sure the main session is registered; returns its session id. */
  function ensureMain(ctx: any): string | undefined {
    const sid = sessionIdOf(ctx);
    if (!sid) return mainSessionId;
    if (mainSessionId === undefined) {
      // Loaded mid-session (e.g. /reload) without a session_start: announce it.
      const agent = agentOf(ctx);
      reg.agents.set(agent.id, sid);
      reg.lastRoot = sid;
      mainSessionId = sid;
      startPayload(ctx, sid, "start");
    } else if (sid !== mainSessionId) {
      // The session id changed under us without a session_switch/session_branch
      // we saw (any future omp path that mints a new id): treat it as a switch so
      // the old card ends and the new one gets cwd/model.
      switchMain(ctx, sid, "switch");
    } else {
      const agent = agentOf(ctx);
      reg.agents.set(agent.id, sid);
      reg.lastRoot = sid;
    }
    return sid;
  }

  /**
   * The main agent moved to a different session id (session_switch, or
   * session_branch for /branch, /fork, /btw which mint a new id): end the
   * previous card and announce the new one.
   */
  function switchMain(ctx: any, sid: string, reason: string): void {
    const prev = mainSessionId;
    if (prev) {
      emit({ type: "session_end", sessionId: prev, reason });
      reg.lastTool.delete(prev);
    }
    mainSessionId = sid;
    const agent = agentOf(ctx);
    reg.agents.set(agent.id, sid);
    // Repoint every live subagent that resolved to the old root.
    if (prev) {
      for (const [id, root] of reg.agents) if (root === prev) reg.agents.set(id, sid);
    }
    reg.lastRoot = sid;
    startPayload(ctx, sid, reason);
  }

  function startPayload(ctx: any, sid: string, source: string): void {
    const agent = agentOf(ctx);
    const payload: Record<string, unknown> = { type: "session_start", sessionId: sid, source, agentId: agent.id };
    if (typeof ctx?.cwd === "string" && ctx.cwd) payload.cwd = ctx.cwd;
    if (typeof ctx?.hasUI === "boolean") payload.hasUI = ctx.hasUI;
    const model = ctx?.model?.id;
    if (typeof model === "string" && model) payload.model = model;
    emit(payload);
  }

  /** Root session id for a subagent ctx, or undefined (T12 fallback). */
  function resolveSubRoot(ctx: any): string | undefined {
    const agent = agentOf(ctx);
    let root: string | undefined;
    if (agent.parentId) root = reg.agents.get(agent.parentId);
    root ??= reg.lastRoot;
    if (root) reg.agents.set(agent.id, root);
    subRootSessionId = root;
    subOwnSessionId = sessionIdOf(ctx) ?? subOwnSessionId;
    return root;
  }

  /**
   * Where an event for this ctx goes: `{ sessionId, agentType? }` or null when
   * it must not be reported (sub without a resolvable root: fallback branch).
   */
  function target(ctx: any): { sessionId: string; agentType?: string } | null {
    const agent = agentOf(ctx);
    if (agent.kind === "main") {
      const sid = ensureMain(ctx);
      return sid ? { sessionId: sid } : null;
    }
    const root = subRootSessionId ?? resolveSubRoot(ctx);
    return root ? { sessionId: root, agentType: agent.name } : null;
  }

  function subagentEvent(ctx: any, type: "subagent_start" | "subagent_stop"): void {
    const agent = agentOf(ctx);
    const root = subRootSessionId ?? resolveSubRoot(ctx);
    if (root) {
      emit({ type, sessionId: root, agentId: agent.id, agentType: agent.name });
      return;
    }
    // T12 fallback: no root in this process; report on our own id with parentId.
    const own = subOwnSessionId ?? sessionIdOf(ctx);
    if (!own) return;
    const payload: Record<string, unknown> = { type, sessionId: own, agentId: agent.id, agentType: agent.name };
    if (agent.parentId) payload.parentId = agent.parentId;
    emit(payload);
  }

  function withTarget(ctx: any, payload: Record<string, unknown>): void {
    const t = target(ctx);
    if (!t) return;
    const out: Record<string, unknown> = { ...payload, sessionId: t.sessionId };
    if (t.agentType) out.agentType = t.agentType;
    emit(out);
  }

  // --- session lifecycle -----------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    const agent = agentOf(ctx);
    if (agent.kind === "sub") {
      resolveSubRoot(ctx);
      return;
    }
    const sid = sessionIdOf(ctx);
    if (!sid) return;
    reg.agents.set(agent.id, sid);
    reg.lastRoot = sid;
    if (mainSessionId === sid) return;
    mainSessionId = sid;
    startPayload(ctx, sid, "start");
  });

  pi.on("session_switch", (_event, ctx) => {
    if (agentOf(ctx).kind !== "main") return;
    const sid = sessionIdOf(ctx);
    if (!sid || sid === mainSessionId) return;
    switchMain(ctx, sid, "switch");
  });

  // /branch, /fork and /btw (AgentSession.branch -> newSession /
  // createBranchedSession) mint a NEW session id and fire only session_branch.
  // (session_tree moves the leaf inside the same session file and keeps the id,
  // so it needs no handler; ensureMain would still catch an id change.)
  pi.on("session_branch", (_event, ctx) => {
    if (agentOf(ctx).kind !== "main") return;
    const sid = sessionIdOf(ctx);
    if (!sid || sid === mainSessionId) return;
    switchMain(ctx, sid, "branch");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const agent = agentOf(ctx);
    if (agent.kind === "sub") {
      if (subStarted) {
        subStarted = false;
        subagentEvent(ctx, "subagent_stop");
      }
      reg.agents.delete(agent.id);
      return;
    }
    const sid = mainSessionId ?? sessionIdOf(ctx);
    if (sid) {
      emit({ type: "session_end", sessionId: sid, reason: "shutdown" });
      reg.lastTool.delete(sid);
      if (reg.lastRoot === sid) reg.lastRoot = undefined;
    }
    mainSessionId = undefined;
    await sender.flush(OMP_SHUTDOWN_WAIT_MS);
  });

  // --- turns -------------------------------------------------------------------

  pi.on("before_agent_start", (event, ctx) => {
    if (agentOf(ctx).kind !== "main") return;
    if (event?.reason === "revive") return;
    const raw = typeof event?.prompt === "string" ? event.prompt.trim() : "";
    if (!raw) return;
    withTarget(ctx, { type: "prompt", text: config.redact ? "" : clip(raw, PROMPT_MAX) });
  });

  pi.on("agent_start", (_event, ctx) => {
    if (agentOf(ctx).kind === "main") {
      ensureMain(ctx);
      return;
    }
    if (subStarted) return;
    subStarted = true;
    subagentEvent(ctx, "subagent_start");
  });

  pi.on("agent_end", (event, ctx) => {
    if (event?.willContinue === true) return;
    if (agentOf(ctx).kind === "sub") {
      if (!subStarted) return;
      subStarted = false;
      subagentEvent(ctx, "subagent_stop");
      return;
    }
    const assistant = lastAssistant(event?.messages);
    if (assistant?.stopReason === "error") {
      const text = assistant.errorMessage || assistantText(assistant) || "error";
      withTarget(ctx, { type: "error", text: clip(String(text), LAST_MESSAGE_MAX) });
      return;
    }
    if (assistant?.stopReason === "aborted") {
      withTarget(ctx, { type: "interrupt" });
      return;
    }
    const text = config.redact ? "" : clip(assistantText(assistant), LAST_MESSAGE_MAX);
    withTarget(ctx, { type: "turn_done", text });
  });

  pi.on("auto_retry_start", (event, ctx) => {
    const attempt = Number.isFinite(event?.attempt) ? event.attempt : undefined;
    const max = Number.isFinite(event?.maxAttempts) ? event.maxAttempts : undefined;
    const counter = attempt !== undefined ? (max !== undefined ? `${attempt}/${max}` : `${attempt}`) : "";
    const reason = config.redact ? "" : oneLine(event?.errorMessage, SUMMARY_MAX);
    const summary = oneLine([counter, reason].filter(Boolean).join(": "), SUMMARY_MAX);
    withTarget(ctx, { type: "tool_start", tool: "retry", summary });
  });

  pi.on("session_before_compact", (_event, ctx) => {
    withTarget(ctx, { type: "compact" });
  });

  // --- tools -------------------------------------------------------------------

  pi.on("tool_execution_start", (event, ctx) => {
    const toolName = typeof event?.toolName === "string" && event.toolName ? event.toolName : "tool";
    const isMain = agentOf(ctx).kind === "main";
    if (toolName === "ask" && isMain) {
      const msg = config.redact ? "" : clip(askQuestion(event?.args), STATE_MSG_MAX);
      withTarget(ctx, { type: "blocked", kind: "question", msg });
      return;
    }
    const t = target(ctx);
    if (!t) return;
    const now = Date.now();
    const last = reg.lastTool.get(t.sessionId);
    if (last !== undefined && now - last < TOOL_THROTTLE_MS) return;
    reg.lastTool.set(t.sessionId, now);
    const summary = config.redact ? "" : argsPreview(event?.args);
    withTarget(ctx, { type: "tool_start", tool: toolName, summary });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event?.toolName !== "ask" || agentOf(ctx).kind !== "main") return;
    withTarget(ctx, { type: "unblocked", kind: "question" });
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    const toolName = typeof event?.toolName === "string" && event.toolName ? event.toolName : "tool";
    const reason = typeof event?.reason === "string" && event.reason.trim() ? event.reason : "";
    const msg = config.redact || !reason ? toolName : clip(reason, STATE_MSG_MAX);
    withTarget(ctx, { type: "blocked", kind: "permission", msg });
  });

  pi.on("tool_approval_resolved", (_event, ctx) => {
    withTarget(ctx, { type: "unblocked", kind: "permission" });
  });

  pi.on("plan_review_requested", (_event, ctx) => {
    withTarget(ctx, { type: "blocked", kind: "question", msg: "plan review" });
  });

  pi.on("plan_review_resolved", (_event, ctx) => {
    withTarget(ctx, { type: "unblocked", kind: "question" });
  });
}

/** Test hook: forget process-wide state (registry + sender). */
export function __resetJobFarmMonForTests(): void {
  delete globalThis[GLOBAL_KEY];
  moduleSender = null;
  moduleSenderKey = "";
}
