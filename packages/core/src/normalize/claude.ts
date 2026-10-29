// Claude Code hook stdin -> canonical events (docs/plan.md "各 agent 事件映射").
import { summarizeTool } from '../summarize.js';
import { str } from '../text.js';
import type { CanonicalEvent } from '../types.js';
import { originBase, readHookPayload, subBase, text } from './common.js';

/** Tools whose PreToolUse means "waiting for the user to answer". */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

const QUESTION_NOTIFICATIONS = new Set([
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog',
]);
const ANSWERED_NOTIFICATIONS = new Set(['elicitation_complete', 'elicitation_response']);

export function normalizeClaude(payload: unknown): CanonicalEvent[] {
  const h = readHookPayload(payload, { subagentNeedsId: true });
  if (!h) return [];
  const { p, base } = h;
  const tool = h.toolName ?? '';
  const summary = () => summarizeTool('claude', tool, h.toolInput, base.cwd);

  switch (h.event) {
    case 'SessionStart': {
      const ev: CanonicalEvent = { type: 'session_start', ...base };
      const model = modelName(p.model);
      if (model) ev.model = model;
      const source = str(p.source);
      if (source) ev.source = source;
      return [ev];
    }
    case 'UserPromptSubmit':
      return [{ type: 'prompt', ...base, text: text(p.prompt) }];
    case 'PreToolUse': {
      if (!tool) return [];
      const s = summary();
      const out: CanonicalEvent[] = [{ type: 'tool_start', ...subBase(h), tool, summary: s }];
      if (QUESTION_TOOLS.has(tool) && !h.agentId) {
        out.push({ type: 'blocked', ...base, kind: 'question', msg: s });
      }
      return out;
    }
    case 'PostToolUse':
      // An ordinary tool finishing only ends a permission wait (also one raised
      // inside a subagent: the event carries its agentId, and the reducer only
      // lets the agent that raised a block clear it); the main agent's question
      // tool's own PostToolUse ends the question.
      if (QUESTION_TOOLS.has(tool) && !h.agentId) return [{ type: 'unblocked', ...base }];
      return [{ type: 'unblocked', ...originBase(h), kind: 'permission' }];
    case 'PostToolUseFailure': {
      const out: CanonicalEvent[] = [{ type: 'progress', ...subBase(h), text: `✗ ${tool || 'tool'} failed` }];
      // A rejected/failed question (e.g. plan rejected) is no longer pending;
      // a failed/denied ordinary tool ends its permission wait.
      if (QUESTION_TOOLS.has(tool) && !h.agentId) out.push({ type: 'unblocked', ...base });
      else out.push({ type: 'unblocked', ...originBase(h), kind: 'permission' });
      return out;
    }
    case 'PermissionRequest': {
      const s = summary();
      // Claude asks "permission" for AskUserQuestion / ExitPlanMode right after
      // their PreToolUse: that is still the question, not a permission prompt.
      if (QUESTION_TOOLS.has(tool)) return [{ type: 'blocked', ...base, kind: 'question', msg: s }];
      const msg = tool ? (s ? `${tool}: ${s}` : tool) : s;
      return [{ type: 'blocked', ...originBase(h), kind: 'permission', msg }];
    }
    case 'Notification': {
      const nt = str(p.notification_type);
      const msg = text(p.message);
      // Generic repeats of a PermissionRequest / AskUserQuestion (no tool name
      // here): `notification` makes the reducer ignore them while the session
      // is already blocked, keeping the specific reason/question.
      if (nt === 'permission_prompt') {
        return [{ type: 'blocked', ...base, kind: 'permission', msg, notification: true }];
      }
      if (nt === 'idle_prompt') return [{ type: 'idle_hint', ...base }];
      if (nt && QUESTION_NOTIFICATIONS.has(nt)) {
        return [{ type: 'blocked', ...base, kind: 'question', msg, notification: true }];
      }
      if (nt && ANSWERED_NOTIFICATIONS.has(nt)) return [{ type: 'unblocked', ...base }];
      return [];
    }
    case 'Stop':
      return h.agentId ? [] : [{ type: 'turn_done', ...base, text: text(p.last_assistant_message) }];
    case 'StopFailure': {
      const t =
        str(p.error) ?? str(p.error_message) ?? str(p.message) ?? str(p.reason) ?? 'stop failure';
      return [{ type: 'error', ...base, text: t }];
    }
    case 'SubagentStart':
    case 'SubagentStop': {
      if (!h.agentId) return [];
      return [
        {
          type: h.event === 'SubagentStart' ? 'subagent_start' : 'subagent_stop',
          ...base,
          agentId: h.agentId,
          agentType: str(p.agent_type) ?? 'subagent',
        },
      ];
    }
    case 'PreCompact':
      return [{ type: 'compact', ...base }];
    case 'SessionEnd': {
      const ev: CanonicalEvent = { type: 'session_end', ...base };
      const reason = str(p.reason);
      if (reason) ev.reason = reason;
      return [ev];
    }
    default:
      return [];
  }
}

/** `model` may be a string or `{ id, display_name }`. */
export function modelName(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v);
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return str(o.id) ?? str(o.display_name);
  }
  return undefined;
}
