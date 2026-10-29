// oh-my-pi: the extension already emits canonical events (OmpPayload). We
// validate `type` against CANONICAL_EVENT_TYPES and the variant's required
// fields, then rebuild a clean CanonicalEvent (extension-only fields such as
// `hasUI` / `agentId` are dropped; `parentId` survives on session_start only).
//
// T12 note: the primary path is "subagent events already carry the root
// sessionId" (same process, confirmed for oh-my-pi 18.13.3). The `parentId`
// fallback (subagent in its own process, not observed in practice) is a known
// limitation: omp's main agent id is always "Main", so a parentId cannot
// identify one session among several on a host; those events get their own
// card under the subagent's session id.
import { CANONICAL_EVENT_TYPES } from '../constants.js';
import { summarizeTool } from '../summarize.js';
import { isRecord, str } from '../text.js';
import type { BlockedKind, CanonicalEvent, CanonicalEventBase, CanonicalEventType } from '../types.js';

const TYPES = new Set<string>(CANONICAL_EVENT_TYPES);
const BLOCKED_KINDS = new Set<string>(['permission', 'question']);

export function normalizeOmp(payload: unknown): CanonicalEvent[] {
  if (!isRecord(payload)) return [];
  const type = str(payload.type);
  const sessionId = str(payload.sessionId);
  if (!type || !sessionId || !TYPES.has(type)) return [];
  const base: CanonicalEventBase = { sessionId };
  const agentType = str(payload.agentType);
  if (agentType) base.agentType = agentType;
  const cwd = str(payload.cwd);
  if (cwd) base.cwd = cwd;
  const text = typeof payload.text === 'string' ? payload.text : '';

  switch (type as CanonicalEventType) {
    case 'session_start': {
      const ev: CanonicalEvent = { type: 'session_start', ...base };
      const model = str(payload.model);
      if (model) ev.model = model;
      const source = str(payload.source);
      if (source) ev.source = source;
      const parentId = str(payload.parentId);
      if (parentId) ev.parentId = parentId;
      return [ev];
    }
    case 'prompt':
      return [{ type: 'prompt', ...base, text }];
    case 'tool_start': {
      const tool = str(payload.tool);
      if (!tool) return [];
      const summary = summarizeTool('omp', tool, payload.summary ?? payload.argsPreview ?? '');
      return [{ type: 'tool_start', ...base, tool, summary }];
    }
    case 'progress':
      return text ? [{ type: 'progress', ...base, text }] : [];
    case 'blocked': {
      const kind = str(payload.kind);
      if (!kind || !BLOCKED_KINDS.has(kind)) return [];
      const msg = typeof payload.msg === 'string' ? payload.msg : '';
      return [{ type: 'blocked', ...base, kind: kind as BlockedKind, msg }];
    }
    case 'turn_done':
      return [{ type: 'turn_done', ...base, text }];
    case 'error':
      return [{ type: 'error', ...base, text }];
    case 'subagent_start':
    case 'subagent_stop': {
      const agentId = str(payload.agentId);
      if (!agentId) return [];
      return [
        { type: type as 'subagent_start' | 'subagent_stop', ...base, agentId, agentType: agentType ?? 'subagent' },
      ];
    }
    case 'session_end': {
      const ev: CanonicalEvent = { type: 'session_end', ...base };
      const reason = str(payload.reason);
      if (reason) ev.reason = reason;
      return [ev];
    }
    case 'unblocked':
    case 'interrupt':
    case 'idle_hint':
    case 'compact':
      return [{ type: type as 'unblocked' | 'interrupt' | 'idle_hint' | 'compact', ...base }];
    default:
      return [];
  }
}
