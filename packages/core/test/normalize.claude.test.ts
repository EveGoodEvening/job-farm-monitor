import { describe, expect, it } from 'vitest';
import { normalize, normalizeClaude } from '../src/index.js';
import { envelope, fixture, fixtureNames } from './helpers.js';

// Real captures (Claude Code 2.1.312), see fixtures/README.md. Sessions:
const cwd = '/home/user/proj';
const headless = { sessionId: '7c86ee5c-c8c5-439f-ad46-d0fdfc54acbc', cwd }; // claude -p: Bash, Read, Explore subagent
const tui = { sessionId: '68d9d8ac-3e39-48f1-a8ea-f5b054899d8d', cwd }; // interactive: AskUserQuestion, notifications
const exited = { sessionId: '0af5f544-7ade-4ca8-b0fc-644f393fcfd9', cwd }; // after /clear, then /exit
const perm = { sessionId: '36ee3903-dcea-4455-9f16-3ae2070079a6', cwd };
const failed = { sessionId: '4f47fd94-52ac-48ab-9f14-7d38acbf1fbd', cwd };
const subagentId = 'a986ba181051e8e8a';
const sub = { ...headless, agentType: 'Explore', agentId: subagentId };
const question = 'Which color?';

const expected: Record<string, unknown[]> = {
  SessionStart: [{ type: 'session_start', ...tui, model: 'claude-haiku-5-5', source: 'startup' }],
  // model is absent headless and on /clear
  'SessionStart.headless': [{ type: 'session_start', ...headless, source: 'startup' }],
  'SessionStart.clear': [{ type: 'session_start', ...exited, source: 'clear' }],
  UserPromptSubmit: [
    {
      type: 'prompt',
      ...headless,
      text: "Do these steps: 1) run the shell command 'echo hi' with Bash. 2) Read the file hello.txt. 3) Use the Agent tool to spawn an Explore subagent with the task 'Read hello.txt in the current directory and report its contents in one word'. Then reply 'done'.",
    },
  ],
  'PreToolUse.Bash': [{ type: 'tool_start', ...headless, tool: 'Bash', summary: 'echo hi' }],
  'PreToolUse.Read': [{ type: 'tool_start', ...headless, tool: 'Read', summary: 'hello.txt' }],
  'PreToolUse.Agent': [{ type: 'tool_start', ...headless, tool: 'Agent', summary: 'Read hello.txt contents' }],
  'PreToolUse.AskUserQuestion': [
    { type: 'tool_start', ...tui, tool: 'AskUserQuestion', summary: question },
    { type: 'blocked', ...tui, kind: 'question', msg: question },
  ],
  'PreToolUse.ExitPlanMode.synthetic': [
    { type: 'tool_start', ...tui, tool: 'ExitPlanMode', summary: 'plan ready for approval' },
    { type: 'blocked', ...tui, kind: 'question', msg: 'plan ready for approval' },
  ],
  'PreToolUse.subagent': [{ type: 'tool_start', ...sub, tool: 'Read', summary: 'hello.txt' }],
  'PostToolUse.Bash': [{ type: 'unblocked', ...headless, kind: 'permission' }],
  'PostToolUse.Agent': [{ type: 'unblocked', ...headless, kind: 'permission' }],
  'PostToolUse.AskUserQuestion': [{ type: 'unblocked', ...tui }],
  // A subagent's tool finishing ends that subagent's permission wait.
  'PostToolUse.subagent': [{ type: 'unblocked', ...headless, agentId: subagentId, kind: 'permission' }],
  PostToolUseFailure: [
    { type: 'progress', ...failed, text: '✗ Bash failed' },
    { type: 'unblocked', ...failed, kind: 'permission' },
  ],
  PermissionRequest: [{ type: 'blocked', ...perm, kind: 'permission', msg: 'Bash: touch perm-test.txt' }],
  // Follows the AskUserQuestion PreToolUse: still a question, not a permission.
  'PermissionRequest.AskUserQuestion': [{ type: 'blocked', ...tui, kind: 'question', msg: question }],
  'Notification.permission_prompt': [
    { type: 'blocked', ...tui, kind: 'permission', msg: 'Claude needs your permission', notification: true },
  ],
  'Notification.idle_prompt': [{ type: 'idle_hint', ...tui }],
  'Notification.agent_needs_input.synthetic': [
    { type: 'blocked', ...tui, kind: 'question', msg: 'Claude needs your input', notification: true },
  ],
  'Notification.elicitation_dialog.synthetic': [
    {
      type: 'blocked',
      ...tui,
      kind: 'question',
      msg: 'MCP server "github" requests input: repository name',
      notification: true,
    },
  ],
  Stop: [{ type: 'turn_done', ...headless, text: 'done' }],
  'StopFailure.synthetic': [{ type: 'error', ...tui, text: 'API Error: 529 overloaded' }],
  SubagentStart: [{ type: 'subagent_start', ...headless, agentId: subagentId, agentType: 'Explore' }],
  SubagentStop: [{ type: 'subagent_stop', ...headless, agentId: subagentId, agentType: 'Explore' }],
  // agent_type "" and no matching SubagentStart: tolerated (reducer ignores unknown ids).
  'SubagentStop.no_start': [
    { type: 'subagent_stop', ...tui, agentId: 'a6d876ce623538262', agentType: 'subagent' },
  ],
  'PreCompact.synthetic': [{ type: 'compact', ...tui }],
  SessionEnd: [{ type: 'session_end', ...exited, reason: 'prompt_input_exit' }],
  'SessionEnd.clear': [{ type: 'session_end', ...tui, reason: 'clear' }],
  'SessionEnd.other': [{ type: 'session_end', ...headless, reason: 'other' }],
};

describe('normalizeClaude', () => {
  it('has an expectation for every fixture', () => {
    expect(fixtureNames('claude')).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s', (name, events) => {
    const payload = fixture('claude', name);
    expect(normalizeClaude(payload)).toEqual(events);
    expect(normalize(envelope('claude', payload))).toEqual(events);
  });

  it('question tools: PermissionRequest stays a question; failure ends it', () => {
    const exitPlan = { hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'ExitPlanMode', tool_input: {} };
    expect(normalizeClaude(exitPlan)).toEqual([
      { type: 'blocked', sessionId: 's', kind: 'question', msg: 'plan ready for approval' },
    ]);
    const rejected = { hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'ExitPlanMode', error: 'rejected' };
    expect(normalizeClaude(rejected)).toEqual([
      { type: 'progress', sessionId: 's', text: '✗ ExitPlanMode failed' },
      { type: 'unblocked', sessionId: 's' },
    ]);
  });

  it('unknown hook events -> []', () => {
    expect(normalizeClaude({ hook_event_name: 'PermissionDenied', session_id: 's' })).toEqual([]);
  });

  it('maps the remaining notification types', () => {
    const n = (notification_type: string) =>
      normalizeClaude({ hook_event_name: 'Notification', session_id: 's', notification_type, message: 'm' });
    const q = [{ type: 'blocked', sessionId: 's', kind: 'question', msg: 'm', notification: true }];
    expect(n('agent_needs_input')).toEqual(q);
    expect(n('elicitation_url_dialog')).toEqual(q);
    expect(n('elicitation_complete')).toEqual([{ type: 'unblocked', sessionId: 's' }]);
    expect(n('elicitation_response')).toEqual([{ type: 'unblocked', sessionId: 's' }]);
    expect(n('auth_success')).toEqual([]);
  });

  it('ignores Stop and question-blocking inside subagents', () => {
    const subStop = { hook_event_name: 'Stop', session_id: 's', agent_id: 'x', last_assistant_message: 'hi' };
    expect(normalizeClaude(subStop)).toEqual([]);
    const subAsk = {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      agent_id: 'abcdef123456',
      tool_name: 'ExitPlanMode',
      tool_input: {},
    };
    expect(normalizeClaude(subAsk)).toEqual([
      {
        type: 'tool_start',
        sessionId: 's',
        agentType: 'abcdef12',
        agentId: 'abcdef123456',
        tool: 'ExitPlanMode',
        summary: 'plan ready for approval',
      },
    ]);
  });

  it('subagent permission prompts carry the agentId that raised them', () => {
    const base = { session_id: 's', agent_id: 'A1', agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'ls' } };
    expect(normalizeClaude({ ...base, hook_event_name: 'PermissionRequest' })).toEqual([
      { type: 'blocked', sessionId: 's', agentId: 'A1', kind: 'permission', msg: 'Bash: ls' },
    ]);
    expect(normalizeClaude({ ...base, hook_event_name: 'PostToolUseFailure' })).toEqual([
      { type: 'progress', sessionId: 's', agentType: 'Explore', agentId: 'A1', text: '✗ Bash failed' },
      { type: 'unblocked', sessionId: 's', agentId: 'A1', kind: 'permission' },
    ]);
  });

  it('agent_type without agent_id (main --agent session) is not a subagent', () => {
    const p = { hook_event_name: 'PreToolUse', session_id: 's', agent_type: 'reviewer', tool_name: 'Read', tool_input: { file_path: '/a' } };
    expect(normalizeClaude(p)).toEqual([{ type: 'tool_start', sessionId: 's', tool: 'Read', summary: '/a' }]);
  });

  it('keeps redacted (blank) text events', () => {
    expect(normalizeClaude({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '' })).toEqual([
      { type: 'prompt', sessionId: 's', text: '' },
    ]);
  });

  it('never throws on garbage', () => {
    for (const p of [null, 1, 'x', [], {}, { hook_event_name: 'Stop' }, { session_id: 's' }]) {
      expect(normalizeClaude(p)).toEqual([]);
    }
  });
});
