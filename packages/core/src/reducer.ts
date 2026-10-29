// Pure, agent-agnostic state machine (docs/plan.md "状态机", todo T23).
import {
  DELAYED_MS,
  LAST_MESSAGE_MAX,
  OUT_OF_ORDER_GRACE_MS,
  PROGRESS_LINE_MAX,
  STALE_MS,
  STATE_MSG_MAX,
  TITLE_MAX,
} from './constants.js';
import { sessionKey } from './key.js';
import { basename, clip, clipLine, firstLine } from './text.js';
import type {
  BlockedKind,
  CanonicalEvent,
  ProgressLine,
  ReduceMeta,
  ReduceResult,
  SessionRow,
  SessionState,
  SubagentMap,
} from './types.js';

export const COMPACT_PROGRESS_TEXT = 'compacting context';

/** Fresh row for an unknown session (state idle, started_at = ts). */
function newSession(ev: CanonicalEvent, meta: ReduceMeta): SessionRow {
  const at = Math.min(meta.ts, meta.receivedAt);
  return {
    key: sessionKey(meta.host, meta.agent, ev.sessionId),
    host: meta.host,
    agent: meta.agent,
    session_id: ev.sessionId,
    cwd: null,
    project: null,
    title: null,
    model: null,
    state: 'idle',
    state_kind: null,
    state_msg: null,
    state_since: meta.ts,
    last_event_at: at,
    started_at: meta.ts,
    ended_at: null,
    last_message: null,
    subagents_json: '{}',
    herdr_pane_id: null,
    herdr_tab_id: null,
    herdr_workspace_id: null,
    tmux_pane: null,
    hostname: null,
    delayed: 0,
    last_ts: meta.ts,
    state_agent: null,
  };
}

function parseSubagents(json: string): SubagentMap {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as SubagentMap;
  } catch {
    // corrupt column -> start over
  }
  return {};
}

function progressText(ev: CanonicalEvent, body: string): string {
  const prefix = ev.agentType && ev.type !== 'subagent_start' && ev.type !== 'subagent_stop'
    ? `[${ev.agentType}] `
    : '';
  return clipLine(prefix + body, PROGRESS_LINE_MAX);
}

/** Progress line an event contributes (also for out-of-order events). */
function lineFor(ev: CanonicalEvent): string | null {
  switch (ev.type) {
    case 'tool_start':
      return progressText(ev, ev.summary ? `${ev.tool}: ${ev.summary}` : ev.tool);
    case 'progress':
      return ev.text.trim() ? progressText(ev, ev.text) : null;
    case 'compact':
      return progressText(ev, COMPACT_PROGRESS_TEXT);
    default:
      return null;
  }
}

function setState(row: SessionRow, state: SessionState, kind: BlockedKind | null, msg: string | null): void {
  row.state = state;
  row.state_kind = kind;
  row.state_msg = msg;
}

/** Apply the state-changing part of an in-order event to `row` (mutates). */
function transition(row: SessionRow, ev: CanonicalEvent, isNew: boolean, at: number): void {
  switch (ev.type) {
    case 'session_start':
      if (ev.model) row.model = ev.model;
      // New -> idle (already). Existing & not ended -> unchanged (Codex
      // subagents reuse the parent id). Ended -> reopened as idle.
      if (!isNew && row.state === 'ended') {
        setState(row, 'idle', null, null);
        row.subagents_json = '{}';
      }
      return;
    case 'prompt': {
      const title = clip(firstLine(ev.text), TITLE_MAX);
      if (title) row.title = title;
      setState(row, 'working', null, null);
      return;
    }
    case 'tool_start':
      if (row.state === 'blocked') {
        // No tool call clears a pending question: questions end with their
        // own PostToolUse/answer (Codex keeps running tools while
        // request_user_input_async is open).
        if (row.state_kind === 'question') return;
        // A permission wait is cleared only by a tool call of the agent that
        // raised it (main agent or that subagent): another (e.g. background)
        // subagent's tool call says nothing about it, nor does one from an
        // unidentified subagent.
        if (ev.agentType && !ev.agentId) return;
        if ((ev.agentId ?? null) !== row.state_agent) return;
      }
      setState(row, 'working', null, null);
      return;
    case 'blocked':
      // A generic notification repeating an already-reported prompt keeps the
      // specific reason / question (and who raised it).
      if (ev.notification && row.state === 'blocked') return;
      setState(row, 'blocked', ev.kind, clip(ev.msg.trim(), STATE_MSG_MAX) || null);
      row.state_agent = ev.agentId ?? null;
      return;
    case 'unblocked':
      if (
        row.state === 'blocked' &&
        (!ev.kind || ev.kind === row.state_kind) &&
        (ev.agentId ?? null) === row.state_agent
      ) {
        setState(row, 'working', null, null);
      }
      return;
    case 'turn_done': {
      const text = clip(ev.text.trim(), LAST_MESSAGE_MAX);
      if (text) row.last_message = text;
      setState(row, 'done', null, null);
      return;
    }
    case 'error': {
      const text = ev.text.trim();
      setState(row, 'error', null, clip(text, STATE_MSG_MAX) || null);
      if (text) row.last_message = clip(text, LAST_MESSAGE_MAX);
      return;
    }
    case 'interrupt':
      setState(row, 'idle', null, null);
      return;
    case 'idle_hint':
      if (row.state === 'working') setState(row, 'done', null, null);
      return;
    case 'subagent_start': {
      const map = parseSubagents(row.subagents_json);
      map[ev.agentId] = { type: ev.agentType, since: at };
      row.subagents_json = JSON.stringify(map);
      return;
    }
    case 'subagent_stop': {
      // A subagent that stops is no longer waiting for its permission prompt.
      if (row.state === 'blocked' && row.state_agent === ev.agentId) setState(row, 'working', null, null);
      const map = parseSubagents(row.subagents_json);
      if (ev.agentId in map) {
        delete map[ev.agentId];
        row.subagents_json = JSON.stringify(map);
      }
      return;
    }
    case 'session_end':
      setState(row, 'ended', null, null);
      row.ended_at = at;
      row.subagents_json = '{}';
      return;
    case 'progress':
    case 'compact':
      return;
  }
}

const ROW_KEYS: readonly (keyof SessionRow)[] = [
  'cwd', 'project', 'title', 'model', 'state', 'state_kind', 'state_msg', 'state_since',
  'last_event_at', 'started_at', 'ended_at', 'last_message', 'subagents_json',
  'herdr_pane_id', 'herdr_tab_id', 'herdr_workspace_id', 'tmux_pane', 'hostname', 'delayed',
  'last_ts', 'state_agent',
];

/** Pure state transition. `prev === null` creates the session. */
export function applyEvent(
  prev: SessionRow | null,
  ev: CanonicalEvent,
  meta: ReduceMeta,
): ReduceResult {
  const isNew = prev === null;
  const row: SessionRow = prev ? { ...prev } : newSession(ev, meta);
  const at = Math.min(meta.ts, meta.receivedAt);

  // Out-of-order guard: much older (by the host's own clock, so a skewed
  // clock does not matter) than what we already applied -> only the progress
  // line (and nothing else) is recorded. Escape hatch for a host clock that
  // stepped back (NTP): a fresh event (not delayed by its own ts) after no
  // in-order event for STALE_MS is applied and becomes the new reference.
  const clockStepBack =
    meta.receivedAt - row.last_event_at > STALE_MS && meta.receivedAt - meta.ts <= DELAYED_MS;
  const outOfOrder = !isNew && meta.ts < row.last_ts - OUT_OF_ORDER_GRACE_MS && !clockStepBack;

  // Progress lines carry the clamped time: a host clock running ahead must
  // not pin its lines above newer ones (lines are ordered by ts).
  const text = lineFor(ev);
  const progressLine: ProgressLine | undefined =
    text === null ? undefined : { ts: at, text, agentType: ev.agentType ?? null };

  if (!outOfOrder) {
    const prevState = row.state;
    const prevKind = row.state_kind;

    transition(row, ev, isNew, at);

    if (row.state !== 'blocked') row.state_agent = null;
    row.last_ts = meta.ts;
    if (row.state !== 'ended') row.ended_at = null;
    if (row.state !== prevState || row.state_kind !== prevKind) row.state_since = at;
    if (at > row.last_event_at) row.last_event_at = at;
    row.delayed = meta.receivedAt - meta.ts > DELAYED_MS ? 1 : 0;

    if (ev.cwd) {
      row.cwd = ev.cwd;
      row.project = basename(ev.cwd);
    }
    const env = meta.env;
    if (env?.herdr_pane_id) row.herdr_pane_id = env.herdr_pane_id;
    if (env?.herdr_tab_id) row.herdr_tab_id = env.herdr_tab_id;
    if (env?.herdr_workspace_id) row.herdr_workspace_id = env.herdr_workspace_id;
    if (env?.tmux_pane) row.tmux_pane = env.tmux_pane;
    if (meta.hostname) row.hostname = meta.hostname;
  }

  const changed =
    isNew || progressLine !== undefined || ROW_KEYS.some((k) => row[k] !== (prev as SessionRow)[k]);

  return progressLine ? { session: row, progressLine, changed } : { session: row, changed };
}
