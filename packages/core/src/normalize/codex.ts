// Codex CLI hook stdin -> canonical events (docs/plan.md "各 agent 事件映射").
// Subagent hooks reuse the parent session_id and carry agent_id + agent_type
// (T11, Codex 0.165.0). The progress prefix is agent_type unless it is empty or
// the generic "default", else agent_id[0..8].
//
// Question tools: request_user_input (Plan mode, synchronous: its PostToolUse
// means answered) and request_user_input_async (Default mode: its PostToolUse
// fires at once with {accepted:true}; the answer arrives later as a
// UserPromptSubmit starting with QUESTION_REPLY_TAG).
import { summarizeTool } from '../summarize.js';
import { str } from '../text.js';
import type { CanonicalEvent } from '../types.js';
import { modelName } from './claude.js';
import { readHookPayload, subBase, text } from './common.js';

const CODEX_QUESTION_TOOLS: ReadonlySet<string> = new Set(['request_user_input', 'request_user_input_async']);
const ASYNC_QUESTION_TOOL = 'request_user_input_async';
const QUESTION_REPLY_TAG = '<send_user_message_question_reply>';
const GENERIC_AGENT_TYPES: ReadonlySet<string> = new Set(['default']);

export function normalizeCodex(payload: unknown): CanonicalEvent[] {
  const h = readHookPayload(payload, { subagentNeedsId: false, genericAgentTypes: GENERIC_AGENT_TYPES });
  if (!h) return [];
  const { p, base } = h;
  const tool = h.toolName ?? '';
  const summary = () => summarizeTool('codex', tool, h.toolInput, base.cwd);

  switch (h.event) {
    case 'SessionStart': {
      const ev: CanonicalEvent = { type: 'session_start', ...base };
      const model = modelName(p.model);
      if (model) ev.model = model;
      const source = str(p.source);
      if (source) ev.source = source;
      return [ev];
    }
    case 'UserPromptSubmit': {
      const prompt = text(p.prompt);
      // Answer to an async question: back to work, but not a new title (an
      // empty prompt keeps the previous title).
      if (prompt.trimStart().startsWith(QUESTION_REPLY_TAG)) return [{ type: 'prompt', ...base, text: '' }];
      return [{ type: 'prompt', ...base, text: prompt }];
    }
    case 'PreToolUse': {
      if (!tool) return [];
      const s = summary();
      const out: CanonicalEvent[] = [{ type: 'tool_start', ...subBase(h), tool, summary: s }];
      if (CODEX_QUESTION_TOOLS.has(tool)) {
        out.push({ type: 'blocked', ...base, kind: 'question', msg: s });
      }
      return out;
    }
    case 'PostToolUse':
      // The async question is still open when its PostToolUse fires.
      if (tool === ASYNC_QUESTION_TOOL) return [];
      // Ordinary tools only end a permission wait (Codex keeps running tools
      // while an async question is open).
      return [CODEX_QUESTION_TOOLS.has(tool) ? { type: 'unblocked', ...base } : { type: 'unblocked', ...base, kind: 'permission' }];
    case 'PermissionRequest': {
      const ti = h.toolInput;
      const desc =
        typeof ti === 'object' && ti !== null ? str((ti as Record<string, unknown>).description) : undefined;
      let msg = desc ?? summary();
      if (!desc && tool) msg = msg ? `${tool}: ${msg}` : tool;
      return [{ type: 'blocked', ...base, kind: 'permission', msg }];
    }
    case 'Stop':
      // A subagent's own Stop (if Codex ever sends one) must not finish the parent turn.
      if (h.agentId) return [];
      return [{ type: 'turn_done', ...base, text: text(p.last_assistant_message) }];
    case 'Interrupt':
      return [{ type: 'interrupt', ...base }];
    case 'SubagentStart':
    case 'SubagentStop': {
      const agentId = h.agentId ?? str(p.subagent_id) ?? str(p.thread_id);
      if (!agentId) return [];
      // Same label as the progress prefix ("default" -> agent_id[0..8]).
      return [
        {
          type: h.event === 'SubagentStart' ? 'subagent_start' : 'subagent_stop',
          ...base,
          agentId,
          agentType: h.subType ?? str(p.agent_role) ?? agentId.slice(0, 8),
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
