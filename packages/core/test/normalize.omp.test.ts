import { describe, expect, it } from 'vitest';
import { normalize, normalizeOmp } from '../src/index.js';
import { envelope, fixture, fixtureNames } from './helpers.js';

const sessionId = 'omp-sess-2b7e91c4';
const base = { sessionId };

const expected: Record<string, unknown[]> = {
  session_start: [
    {
      type: 'session_start',
      ...base,
      cwd: '/home/dev/work/job-farm-monitor',
      model: 'anthropic/claude-opus-5-5',
      source: 'start',
    },
  ],
  prompt: [{ type: 'prompt', ...base, text: 'Refactor the reducer' }],
  tool_start: [{ type: 'tool_start', ...base, tool: 'bash', summary: 'npm run typecheck -w @jfm/core' }],
  'tool_start.subagent': [
    { type: 'tool_start', ...base, agentType: 'task', tool: 'read', summary: 'packages/core/src/reducer.ts' },
  ],
  'blocked.question': [{ type: 'blocked', ...base, kind: 'question', msg: 'Keep the old reducer API?' }],
  'blocked.permission': [{ type: 'blocked', ...base, kind: 'permission', msg: 'bash: rm -rf node_modules' }],
  'blocked.plan_review': [{ type: 'blocked', ...base, kind: 'question', msg: 'plan review' }],
  unblocked: [{ type: 'unblocked', ...base }],
  turn_done: [{ type: 'turn_done', ...base, text: 'Reducer refactored; tests pass.' }],
  error: [{ type: 'error', ...base, text: '429 rate limited' }],
  subagent_start: [{ type: 'subagent_start', ...base, agentId: 'agent-sub-07', agentType: 'task' }],
  subagent_stop: [{ type: 'subagent_stop', ...base, agentId: 'agent-sub-07', agentType: 'task' }],
  compact: [{ type: 'compact', ...base }],
  session_end: [{ type: 'session_end', ...base, reason: 'shutdown' }],
  'session_end.switch': [{ type: 'session_end', ...base, reason: 'switch' }],
  invalid_type: [],
};

describe('normalizeOmp', () => {
  it('has an expectation for every fixture', () => {
    expect(fixtureNames('omp')).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s', (name, events) => {
    const payload = fixture('omp', name);
    expect(normalizeOmp(payload)).toEqual(events);
    expect(normalize(envelope('omp', payload))).toEqual(events);
  });

  it('drops extension-only fields but keeps parentId on session_start', () => {
    expect(
      normalizeOmp({ type: 'session_start', sessionId: 'c', parentId: 'agent-main-01', hasUI: false, agentId: 'x' }),
    ).toEqual([{ type: 'session_start', sessionId: 'c', parentId: 'agent-main-01' }]);
  });

  it('rejects variants missing required fields', () => {
    expect(normalizeOmp({ type: 'blocked', sessionId: 's', kind: 'auth', msg: 'x' })).toEqual([]);
    expect(normalizeOmp({ type: 'tool_start', sessionId: 's' })).toEqual([]);
    expect(normalizeOmp({ type: 'subagent_start', sessionId: 's', agentType: 'task' })).toEqual([]);
    expect(normalizeOmp({ type: 'prompt' })).toEqual([]);
    expect(normalizeOmp('prompt')).toEqual([]);
  });

  it('clamps an overlong summary to one line', () => {
    const [ev] = normalizeOmp({ type: 'tool_start', sessionId: 's', tool: 'bash', summary: `a\nb${'x'.repeat(300)}` });
    expect(ev).toMatchObject({ type: 'tool_start' });
    expect((ev as { summary: string }).summary.length).toBeLessThanOrEqual(120);
    expect((ev as { summary: string }).summary.startsWith('a b')).toBe(true);
  });
});
