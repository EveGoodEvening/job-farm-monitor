// Shared helpers for the hook-payload normalizers (claude, codex).
import { isRecord, str } from '../text.js';
import type { CanonicalEventBase } from '../types.js';

export interface HookPayload {
  /** The raw object (narrowed). */
  p: Record<string, unknown>;
  event: string;
  base: CanonicalEventBase;
  /** Set when the hook fired inside a subagent. */
  agentId?: string;
  /** Progress-line prefix for subagent events (T11 rule). */
  subType?: string;
  toolName?: string;
  toolInput: unknown;
}

/**
 * Narrow a hook stdin payload. Returns null when it lacks `hook_event_name`
 * or `session_id` (nothing we can attribute).
 */
export function readHookPayload(
  payload: unknown,
  opts: {
    subagentNeedsId: boolean;
    /** agent_type values too generic for a prefix (Codex: "default"). */
    genericAgentTypes?: ReadonlySet<string>;
  },
): HookPayload | null {
  if (!isRecord(payload)) return null;
  const event = str(payload.hook_event_name);
  const sessionId = str(payload.session_id);
  if (!event || !sessionId) return null;
  const base: CanonicalEventBase = { sessionId };
  const cwd = str(payload.cwd);
  if (cwd) base.cwd = cwd;
  const agentId = str(payload.agent_id);
  const agentType = str(payload.agent_type);
  // T11 prefix chain: agent_type (unless empty or generic, e.g. Codex
  // "default"), else first 8 chars of agent_id, else the generic type.
  const specific = agentType && !opts.genericAgentTypes?.has(agentType) ? agentType : undefined;
  const subType = specific ?? (agentId ? agentId.slice(0, 8) : agentType);
  const out: HookPayload = { p: payload, event, base, toolInput: payload.tool_input };
  if (agentId) out.agentId = agentId;
  // Claude sets agent_type alone for a main session started with --agent, so
  // only agent_id marks a subagent there; Codex may report either (T11).
  if (agentId || (!opts.subagentNeedsId && agentType)) out.subType = subType;
  const toolName = str(payload.tool_name);
  if (toolName) out.toolName = toolName;
  return out;
}

/** Base fields plus `agentType` (and `agentId`) when the event came from a subagent. */
export function subBase(h: HookPayload): CanonicalEventBase {
  const out: CanonicalEventBase = { ...h.base };
  if (h.subType) out.agentType = h.subType;
  if (h.agentId) out.agentId = h.agentId;
  return out;
}

/** Base fields plus `agentId` (no progress prefix) for blocked/unblocked events. */
export function originBase(h: HookPayload): CanonicalEventBase {
  return h.agentId ? { ...h.base, agentId: h.agentId } : { ...h.base };
}

/** Text field or '' (redacted/missing text still yields the event). */
export function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
