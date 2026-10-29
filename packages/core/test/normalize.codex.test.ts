import { describe, expect, it } from 'vitest';
import { normalize, normalizeCodex } from '../src/index.js';
import { envelope, fixture, fixtureNames } from './helpers.js';

// Real captures (Codex 0.165.0), see fixtures/README.md.
const cwd = '/home/user/proj';
const base = { sessionId: '01a186f2-6d25-7cb2-8154-6bf287e0ae22', cwd }; // interactive app
const cleared = { sessionId: '01a186f6-8197-74f0-b0aa-ed3cb630efc9', cwd }; // after /clear
const exec = { sessionId: '01a186f7-ac74-7510-b355-765ee7a6ea43', cwd }; // codex exec
const agentId = '01a186f2-affe-7b03-9c7e-e0e0eb4b9642';
// agent_type is the generic "default" -> prefix is agent_id[0..8] (T11).
const sub = { ...base, agentType: '01a186f2', agentId };
const question = 'Which color?';

const expected: Record<string, unknown[]> = {
  SessionStart: [{ type: 'session_start', ...base, model: 'gpt-6-luna', source: 'startup' }],
  'SessionStart.clear': [{ type: 'session_start', ...cleared, model: 'gpt-6-luna', source: 'clear' }],
  'SessionStart.exec': [{ type: 'session_start', ...exec, model: 'gpt-6-luna', source: 'startup' }],
  UserPromptSubmit: [
    {
      type: 'prompt',
      ...base,
      text: "Steps: 1) run the shell command 'echo hi'. 2) Spawn one sub-agent whose task is: 'run the shell command cat hello.txt and report the output'. Wait for it to finish. 3) Reply 'done'.",
    },
  ],
  // Answer to request_user_input_async: back to work, title untouched.
  'UserPromptSubmit.question_reply': [{ type: 'prompt', ...base, text: '' }],
  'PreToolUse.Bash': [{ type: 'tool_start', ...base, tool: 'Bash', summary: 'echo hi' }],
  'PreToolUse.Bash.before_permission': [
    { type: 'tool_start', ...base, tool: 'Bash', summary: 'touch /home/user/jfm-perm-probe.txt' },
  ],
  'PreToolUse.clocksleep': [{ type: 'tool_start', ...base, tool: 'clocksleep', summary: '' }],
  'PreToolUse.spawn_agent': [
    { type: 'tool_start', ...base, tool: 'collaborationspawn_agent', summary: 'cat_hello' },
  ],
  'PreToolUse.wait_agent': [
    { type: 'tool_start', ...base, tool: 'collaborationwait_agent', summary: 'waiting for subagents' },
  ],
  'PreToolUse.request_user_input': [
    { type: 'tool_start', ...base, tool: 'request_user_input', summary: question },
    { type: 'blocked', ...base, kind: 'question', msg: question },
  ],
  'PreToolUse.request_user_input_async': [
    { type: 'tool_start', ...base, tool: 'request_user_input_async', summary: question },
    { type: 'blocked', ...base, kind: 'question', msg: question },
  ],
  'PreToolUse.subagent': [{ type: 'tool_start', ...sub, tool: 'Bash', summary: 'cat hello.txt' }],
  'PostToolUse.Bash': [{ type: 'unblocked', ...base, kind: 'permission' }],
  'PostToolUse.subagent': [{ type: 'unblocked', ...base, kind: 'permission' }],
  'PostToolUse.spawn_agent': [{ type: 'unblocked', ...base, kind: 'permission' }],
  'PostToolUse.wait_agent': [{ type: 'unblocked', ...base, kind: 'permission' }],
  'PostToolUse.request_user_input': [{ type: 'unblocked', ...base }],
  // Fires at once with {accepted:true}; the question is still open.
  'PostToolUse.request_user_input_async': [],
  PermissionRequest: [
    {
      type: 'blocked',
      ...base,
      kind: 'permission',
      msg: 'May I create /home/user/jfm-perm-probe.txt outside the workspace as requested?',
    },
  ],
  Stop: [{ type: 'turn_done', ...base, text: 'done' }],
  'Stop.null_message': [{ type: 'turn_done', ...base, text: '' }],
  Interrupt: [{ type: 'interrupt', ...base }],
  SubagentStart: [{ type: 'subagent_start', ...base, agentId, agentType: '01a186f2' }],
  SubagentStop: [{ type: 'subagent_stop', ...base, agentId, agentType: '01a186f2' }],
  'PreCompact.synthetic': [{ type: 'compact', ...base }],
  SessionEnd: [{ type: 'session_end', ...exec, reason: 'other' }],
};

describe('normalizeCodex', () => {
  it('has an expectation for every fixture', () => {
    expect(fixtureNames('codex')).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s', (name, events) => {
    const payload = fixture('codex', name);
    expect(normalizeCodex(payload)).toEqual(events);
    expect(normalize(envelope('codex', payload))).toEqual(events);
  });

  it('T11 prefix fallback: agent_id prefix when agent_type is missing', () => {
    const p = {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      agent_id: '0123456789abcdef',
      tool_name: 'exec_command',
      tool_input: { cmd: 'pwd' },
    };
    expect(normalizeCodex(p)).toEqual([
      { type: 'tool_start', sessionId: 's', agentType: '01234567', agentId: '0123456789abcdef', tool: 'exec_command', summary: 'pwd' },
    ]);
  });

  it('T11 prefix: a specific agent_type wins over the agent_id prefix', () => {
    const p = { ...fixture('codex', 'PreToolUse.subagent'), agent_type: 'explorer' };
    expect(normalizeCodex(p)).toEqual([
      { type: 'tool_start', ...base, agentType: 'explorer', agentId, tool: 'Bash', summary: 'cat hello.txt' },
    ]);
    const start = { ...fixture('codex', 'SubagentStart'), agent_type: '' };
    expect(normalizeCodex(start)).toEqual([{ type: 'subagent_start', ...base, agentId, agentType: '01a186f2' }]);
  });

  it('a prompt that only mentions the reply tag is a normal prompt', () => {
    const p = { ...fixture('codex', 'UserPromptSubmit'), prompt: 'explain <send_user_message_question_reply>' };
    expect(normalizeCodex(p)).toEqual([{ type: 'prompt', ...base, text: 'explain <send_user_message_question_reply>' }]);
  });

  it('PermissionRequest without description falls back to tool: summary', () => {
    const p = { ...fixture('codex', 'PermissionRequest'), tool_input: { command: 'curl https://example.com' } };
    expect(normalizeCodex(p)).toEqual([
      { type: 'blocked', ...base, kind: 'permission', msg: 'Bash: curl https://example.com' },
    ]);
  });

  it('PostCompact is ignored', () => {
    expect(normalizeCodex({ ...fixture('codex', 'PreCompact.synthetic'), hook_event_name: 'PostCompact' })).toEqual([]);
  });

  it('unknown events and garbage -> []', () => {
    expect(normalizeCodex({ hook_event_name: 'Whatever', session_id: 's' })).toEqual([]);
    expect(normalizeCodex(undefined)).toEqual([]);
    expect(normalizeCodex({ hook_event_name: 'PreToolUse', session_id: 's' })).toEqual([]);
  });
});
