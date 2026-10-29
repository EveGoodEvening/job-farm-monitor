import { SUMMARY_MAX } from './constants.js';
import { clipLine, firstLine, isRecord, str } from './text.js';
import type { AgentKind } from './types.js';

/** Fixed summary for Claude's ExitPlanMode (plan approval prompt). */
export const PLAN_READY_SUMMARY = 'plan ready for approval';

/**
 * One-line summary of a tool call, <= SUMMARY_MAX chars. `cwd`, when given,
 * makes file paths relative to it.
 */
export function summarizeTool(
  agent: AgentKind,
  toolName: string,
  input: unknown,
  cwd?: string,
): string {
  let raw: string | undefined;
  try {
    raw =
      agent === 'claude'
        ? claudeSummary(toolName, input, cwd)
        : agent === 'codex'
          ? codexSummary(toolName, input, cwd)
          : ompSummary(input);
    raw ??= firstStringField(input);
  } catch {
    raw = undefined;
  }
  return clipLine(raw ?? '', SUMMARY_MAX);
}

// ---------------------------------------------------------------------------

function relPath(p: string | undefined, cwd: string | undefined): string | undefined {
  if (!p) return undefined;
  if (cwd) {
    const base = cwd.replace(/\/+$/u, '');
    if (base && p.startsWith(base + '/')) return p.slice(base.length + 1);
    if (p === base) return '.';
  }
  return p;
}

function field(input: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const k of keys) {
    const v = str(input[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function firstStringField(input: unknown): string | undefined {
  if (typeof input === 'string') return str(input);
  if (!isRecord(input)) return undefined;
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** `mcp__<server>__<tool>` -> `server/tool` (server may itself contain `_`). */
function mcpName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice(5);
  const i = rest.lastIndexOf('__');
  if (i <= 0) return rest || undefined;
  return `${rest.slice(0, i)}/${rest.slice(i + 2)}`;
}

/** First question text from `{ questions: [{ question }] }` or `{ question }`. */
function firstQuestion(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const qs = input.questions;
  if (Array.isArray(qs)) {
    for (const q of qs) {
      if (typeof q === 'string' && q.trim()) return q;
      const t = field(q, 'question', 'title', 'prompt', 'header');
      if (t) return t;
    }
  }
  return field(input, 'question', 'prompt');
}

function claudeSummary(tool: string, input: unknown, cwd?: string): string | undefined {
  const mcp = mcpName(tool);
  if (mcp) return mcp;
  switch (tool) {
    case 'Bash':
    case 'BashOutput':
      return firstLine(field(input, 'command', 'description') ?? '') || undefined;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
    case 'NotebookRead':
      return relPath(field(input, 'file_path', 'notebook_path', 'path'), cwd);
    case 'Grep':
    case 'Glob':
      return field(input, 'pattern');
    case 'Agent':
    case 'Task':
      return field(input, 'description', 'subagent_type', 'prompt');
    case 'WebFetch':
      return field(input, 'url');
    case 'WebSearch':
      return field(input, 'query');
    case 'Skill':
      return field(input, 'skill', 'command');
    case 'AskUserQuestion':
      return firstQuestion(input);
    case 'ExitPlanMode':
      return PLAN_READY_SUMMARY;
    default:
      return undefined;
  }
}

// Codex 0.165.0 reports its shell tool as "Bash".
const SHELL_TOOLS = new Set(['Bash', 'shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec']);

/** Summary for Codex `collaborationwait_agent` (input is only `{ timeout_ms }`). */
export const WAIT_AGENT_SUMMARY = 'waiting for subagents';

/** `["bash","-lc","npm test"]` -> `npm test`; other arrays are joined. */
function commandText(cmd: unknown): string | undefined {
  if (typeof cmd === 'string') return str(cmd);
  if (!Array.isArray(cmd)) return undefined;
  const parts = cmd.filter((p): p is string => typeof p === 'string');
  if (parts.length === 0) return undefined;
  const sh = parts[0]?.split('/').pop() ?? '';
  if (
    parts.length >= 3 &&
    ['sh', 'bash', 'zsh', 'dash'].includes(sh) &&
    (parts[1] === '-c' || parts[1] === '-lc')
  ) {
    return parts.slice(2).join(' ');
  }
  return parts.join(' ');
}

function shellCommand(input: unknown): string | undefined {
  if (typeof input === 'string') return str(input);
  if (Array.isArray(input)) return commandText(input);
  if (!isRecord(input)) return undefined;
  return commandText(input.command) ?? commandText(input.cmd) ?? commandText(input.argv);
}

/** Count files in an apply_patch body; summary "N files: first/path". */
function patchSummary(input: unknown, cwd?: string): string | undefined {
  let text: string | undefined;
  if (typeof input === 'string') text = input;
  else if (isRecord(input)) {
    text = field(input, 'input', 'patch');
    if (!text && Array.isArray(input.command)) {
      text = input.command.filter((p): p is string => typeof p === 'string').join('\n');
    }
  }
  if (!text) return undefined;
  const files: string[] = [];
  for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) {
    const p = m[1]?.trim();
    if (p) files.push(p);
  }
  if (files.length === 0) return undefined;
  const first = relPath(files[0], cwd) ?? files[0];
  return `${files.length} file${files.length === 1 ? '' : 's'}: ${first}`;
}

function planSummary(input: unknown): string | undefined {
  if (!isRecord(input) || !Array.isArray(input.plan)) return field(input, 'explanation');
  for (const step of input.plan) {
    if (isRecord(step) && step.status === 'in_progress') {
      const s = field(step, 'step');
      if (s) return s;
    }
  }
  return field(input, 'explanation');
}

function codexSummary(tool: string, input: unknown, cwd?: string): string | undefined {
  const mcp = mcpName(tool);
  if (mcp) return mcp;
  if (SHELL_TOOLS.has(tool)) return firstLine(shellCommand(input) ?? '') || undefined;
  switch (tool) {
    case 'apply_patch':
      return patchSummary(input, cwd);
    case 'update_plan':
      return planSummary(input);
    case 'request_user_input':
    case 'request_user_input_async':
      return firstQuestion(input);
    // Namespaced tools arrive glued to their namespace ("collaboration" +
    // "spawn_agent"). spawn_agent.message is an encrypted blob: use task_name.
    case 'collaborationspawn_agent':
    case 'spawn_agent':
      return field(input, 'task_name', 'agent_type', 'description');
    case 'collaborationwait_agent':
    case 'wait_agent':
      return WAIT_AGENT_SUMMARY;
    case 'web_search':
    case 'web_search_preview':
      return field(input, 'query');
    case 'view_image':
      return relPath(field(input, 'path'), cwd);
    default:
      return undefined;
  }
}

/** omp sends a ready-made `argsPreview` (string) or an object carrying it. */
function ompSummary(input: unknown): string | undefined {
  if (typeof input === 'string') return str(input);
  return field(input, 'argsPreview');
}
