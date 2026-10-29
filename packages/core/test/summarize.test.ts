import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX, summarizeTool } from '../src/index.js';
import { fixture } from './helpers.js';

const CWD = '/home/user/proj';

function tool(agent: 'claude' | 'codex', name: string): [string, unknown, string] {
  const p = fixture(agent, name);
  return [p.tool_name as string, p.tool_input, p.cwd as string];
}

describe('summarizeTool: claude (fixtures)', () => {
  it.each([
    ['PreToolUse.Bash', 'echo hi'],
    ['PreToolUse.Read', 'hello.txt'],
    ['PreToolUse.Agent', 'Read hello.txt contents'],
    ['PreToolUse.AskUserQuestion', 'Which color?'],
    ['PreToolUse.ExitPlanMode.synthetic', 'plan ready for approval'],
    ['PreToolUse.subagent', 'hello.txt'],
    ['PermissionRequest', 'touch perm-test.txt'],
    ['PostToolUseFailure', 'cat ./missing-file.txt'],
  ])('%s -> %s', (name, expected) => {
    const [t, input, cwd] = tool('claude', name);
    expect(summarizeTool('claude', t, input, cwd)).toBe(expected);
  });

  it('covers the remaining claude tools', () => {
    expect(summarizeTool('claude', 'Edit', { file_path: `${CWD}/packages/core/src/store.ts` }, CWD)).toBe(
      'packages/core/src/store.ts',
    );
    expect(summarizeTool('claude', 'mcp__plugin_context7_context7__query-docs', { q: 1 })).toBe(
      'plugin_context7_context7/query-docs',
    );
    expect(summarizeTool('claude', 'Grep', { pattern: 'applyEvent' })).toBe('applyEvent');
    expect(summarizeTool('claude', 'Write', { file_path: `${CWD}/a/b.ts` }, CWD)).toBe('a/b.ts');
    expect(summarizeTool('claude', 'Read', { file_path: '/etc/hosts' }, CWD)).toBe('/etc/hosts');
    expect(summarizeTool('claude', 'NotebookEdit', { notebook_path: `${CWD}/n.ipynb` }, CWD)).toBe('n.ipynb');
    expect(summarizeTool('claude', 'Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(summarizeTool('claude', 'Agent', { description: 'Find callers', prompt: 'long' })).toBe('Find callers');
    expect(summarizeTool('claude', 'WebFetch', { url: 'https://hono.dev', prompt: 'x' })).toBe('https://hono.dev');
    expect(summarizeTool('claude', 'WebSearch', { query: 'zod 4 record' })).toBe('zod 4 record');
    expect(summarizeTool('claude', 'Skill', { skill: 'commit-push' })).toBe('commit-push');
    expect(summarizeTool('claude', 'TodoWrite', { todos: [], note: 'first string' })).toBe('first string');
    expect(summarizeTool('claude', 'Mystery', 42)).toBe('');
    expect(summarizeTool('claude', 'Bash', null)).toBe('');
  });
});

describe('summarizeTool: codex (fixtures)', () => {
  it.each([
    ['PreToolUse.Bash', 'echo hi'],
    ['PreToolUse.subagent', 'cat hello.txt'],
    ['PreToolUse.spawn_agent', 'cat_hello'],
    ['PreToolUse.wait_agent', 'waiting for subagents'],
    ['PreToolUse.clocksleep', ''],
    ['PreToolUse.request_user_input', 'Which color?'],
    ['PreToolUse.request_user_input_async', 'Which color?'],
    ['PermissionRequest', 'touch /home/user/jfm-perm-probe.txt'],
  ])('%s -> %s', (name, expected) => {
    const [t, input, cwd] = tool('codex', name);
    expect(summarizeTool('codex', t, input, cwd)).toBe(expected);
  });

  it('covers tools not in the captures', () => {
    expect(summarizeTool('codex', 'exec_command', { cmd: ['bash', '-lc', 'npm test -w @jfm/core'] })).toBe(
      'npm test -w @jfm/core',
    );
    expect(summarizeTool('codex', 'shell', { command: ['rg', '-n', 'applyEvent', 'packages/core'] })).toBe(
      'rg -n applyEvent packages/core',
    );
    const patch =
      '*** Begin Patch\n*** Add File: packages/core/src/drivers/libsql.ts\n+x\n*** Update File: packages/core/src/index.ts\n*** End Patch';
    expect(summarizeTool('codex', 'apply_patch', { input: patch }, CWD)).toBe(
      '2 files: packages/core/src/drivers/libsql.ts',
    );
    expect(
      summarizeTool('codex', 'update_plan', {
        plan: [
          { step: 'Write schema', status: 'completed' },
          { step: 'Implement libsql driver', status: 'in_progress' },
        ],
      }),
    ).toBe('Implement libsql driver');
    expect(summarizeTool('codex', 'web_search', { query: 'libsql client transaction write mode' })).toBe(
      'libsql client transaction write mode',
    );
    expect(summarizeTool('codex', 'spawn_agent', { agent_type: 'explorer', message: 'gAAAA' })).toBe('explorer');
  });

  it('joins plain command arrays and handles single-file patches', () => {
    expect(summarizeTool('codex', 'local_shell', { command: ['git', 'status', '--short'] })).toBe(
      'git status --short',
    );
    expect(summarizeTool('codex', 'shell_command', { command: 'ls -la' })).toBe('ls -la');
    expect(
      summarizeTool('codex', 'apply_patch', { input: '*** Begin Patch\n*** Delete File: old.ts\n*** End Patch' }),
    ).toBe('1 file: old.ts');
    expect(summarizeTool('codex', 'mcp__github__get_issue', { n: 1 })).toBe('github/get_issue');
  });
});

describe('summarizeTool: omp and limits', () => {
  it('uses argsPreview as-is', () => {
    expect(summarizeTool('omp', 'bash', 'npm run build')).toBe('npm run build');
    expect(summarizeTool('omp', 'read', { argsPreview: 'src/a.ts' })).toBe('src/a.ts');
  });

  it('is single-line and <= SUMMARY_MAX', () => {
    const long = 'x'.repeat(500);
    const out = summarizeTool('claude', 'Grep', { pattern: `a\n\tb ${long}` });
    expect(out.startsWith('a b xxx')).toBe(true);
    expect(out).not.toMatch(/\n/);
    expect(Array.from(out)).toHaveLength(SUMMARY_MAX);
    expect(out.endsWith('…')).toBe(true);
    const emoji = summarizeTool('omp', 't', '😀'.repeat(200));
    expect(Array.from(emoji)).toHaveLength(SUMMARY_MAX);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});
