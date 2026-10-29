// T33: oh-my-pi extension driven by a fake `pi` / `ctx`; asserts the envelopes
// that reach `fetch`. No real omp, no network, no real config (temp HOME/XDG).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Handler = (event: unknown, ctx: unknown) => unknown;
type Payload = Record<string, unknown> & { type: string; sessionId: string };
type Envelope = {
  v: number;
  id: string;
  ts: number;
  agent: string;
  hostname?: string;
  pid?: number;
  env?: Record<string, string>;
  payload: Payload;
};

const ENDPOINT = 'https://jfm.example.test';
const TOKEN = 'tok-omp-test';
const MODULE = '../omp/job-farm-mon.ts';

class FakePi {
  handlers = new Map<string, Handler[]>();
  on(name: string, handler: Handler): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }
  async fire(name: string, event: Record<string, unknown>, ctx: unknown): Promise<void> {
    for (const h of this.handlers.get(name) ?? []) await h({ type: name, ...event }, ctx);
  }
}

function mainCtx(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    cwd: '/work/proj',
    model: { id: 'claude-test', provider: 'anthropic' },
    sessionManager: { getSessionId: () => sessionId },
    agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 },
    ...extra,
  };
}

function subCtx(sessionId: string, id: string, name: string, parentId?: string) {
  return {
    hasUI: false,
    cwd: '/work/proj',
    sessionManager: { getSessionId: () => sessionId },
    agent: { kind: 'sub', id, name, depth: 1, parentId },
  };
}

let tmp: string;
let fetchMock: ReturnType<typeof vi.fn>;
let calls: { url: string; init: RequestInit }[];

function sent(): Envelope[] {
  return calls.flatMap((c) => JSON.parse(String(c.init.body)) as Envelope[]);
}
const payloads = (): Payload[] => sent().map((e) => e.payload);

async function load(opts: { reset?: boolean } = {}) {
  if (opts.reset !== false) vi.resetModules();
  const mod = await import(MODULE);
  if (opts.reset !== false) mod.__resetJobFarmMonForTests();
  return mod;
}

async function setup(): Promise<FakePi> {
  const mod = await load();
  const pi = new FakePi();
  mod.default(pi);
  return pi;
}

const okResponse = () => new Response('{"accepted":1,"ignored":0,"revision":1}', { status: 200 });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jfm-omp-'));
  vi.stubEnv('HOME', tmp);
  vi.stubEnv('XDG_CONFIG_HOME', join(tmp, 'xdg'));
  vi.stubEnv('JFM_ENDPOINT', `${ENDPOINT}/`);
  vi.stubEnv('JFM_WRITE_TOKEN', TOKEN);
  vi.stubEnv('JFM_DISABLE', '');
  vi.stubEnv('JFM_REDACT', '');
  vi.stubEnv('HERDR_PANE_ID', 'wS:p1');
  vi.stubEnv('HERDR_TAB_ID', '');
  vi.stubEnv('HERDR_WORKSPACE_ID', 'wS');
  vi.stubEnv('TMUX_PANE', '');
  calls = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return okResponse();
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('config', () => {
  test('missing endpoint/token: registers nothing', async () => {
    vi.stubEnv('JFM_ENDPOINT', '');
    vi.stubEnv('JFM_WRITE_TOKEN', '');
    const pi = await setup();
    expect(pi.handlers.size).toBe(0);
  });

  test('JFM_DISABLE=1: registers nothing', async () => {
    vi.stubEnv('JFM_DISABLE', '1');
    const pi = await setup();
    expect(pi.handlers.size).toBe(0);
  });

  test('reads $XDG_CONFIG_HOME/job-farm-mon/config; env wins', async () => {
    vi.stubEnv('JFM_ENDPOINT', '');
    vi.stubEnv('JFM_WRITE_TOKEN', '');
    mkdirSync(join(tmp, 'xdg', 'job-farm-mon'), { recursive: true });
    writeFileSync(
      join(tmp, 'xdg', 'job-farm-mon', 'config'),
      `# comment\nJFM_ENDPOINT="https://cfg.example.test"\nexport JFM_WRITE_TOKEN='cfg-token'\nJFM_REDACT=0\n`,
    );
    const mod = await load();
    expect(mod.loadConfig(process.env)).toEqual({
      endpoint: 'https://cfg.example.test',
      token: 'cfg-token',
      redact: false,
    });
    vi.stubEnv('JFM_WRITE_TOKEN', 'env-token');
    expect(mod.loadConfig(process.env)?.token).toBe('env-token');
  });

  test('falls back to ~/.config when XDG_CONFIG_HOME is unset', async () => {
    vi.stubEnv('JFM_ENDPOINT', '');
    vi.stubEnv('JFM_WRITE_TOKEN', '');
    vi.stubEnv('XDG_CONFIG_HOME', '');
    mkdirSync(join(tmp, '.config', 'job-farm-mon'), { recursive: true });
    writeFileSync(
      join(tmp, '.config', 'job-farm-mon', 'config'),
      'JFM_ENDPOINT=https://home.example.test\nJFM_WRITE_TOKEN=home-token\nJFM_DISABLE=1\n',
    );
    const mod = await load();
    expect(mod.loadConfig(process.env)).toBeNull();
  });
});

describe('main session', () => {
  test('every mapped event path produces the canonical payload', async () => {
    const pi = await setup();
    const ctx = mainCtx('S1');
    const now = vi.spyOn(Date, 'now');
    let t = 1_761_721_234_567;
    now.mockImplementation(() => (t += 5_000)); // never trips the 2 s tool throttle

    await pi.fire('session_start', {}, ctx);
    await pi.fire('before_agent_start', { reason: 'prompt', prompt: `fix the bug\n${'x'.repeat(400)}` }, ctx);
    await pi.fire('before_agent_start', { reason: 'revive', prompt: '' }, ctx);
    await pi.fire('agent_start', {}, ctx);
    await pi.fire('tool_execution_start', { toolName: 'bash', args: { command: 'npm test\n--watch' } }, ctx);
    await pi.fire('tool_execution_start', { toolName: 'read', args: { path: 'src/a.ts' } }, ctx);
    await pi.fire('tool_execution_start', { toolName: 'ask', args: { questions: [{ question: 'Which DB?' }] } }, ctx);
    await pi.fire('tool_execution_end', { toolName: 'ask', isError: false }, ctx);
    await pi.fire('tool_execution_end', { toolName: 'bash', isError: false }, ctx);
    await pi.fire('tool_approval_requested', { toolName: 'bash', reason: 'rm -rf build' }, ctx);
    await pi.fire('tool_approval_resolved', { toolName: 'bash', approved: true }, ctx);
    await pi.fire('tool_approval_requested', { toolName: 'write' }, ctx);
    await pi.fire('plan_review_requested', { reviewId: 'r1' }, ctx);
    await pi.fire('plan_review_resolved', { reviewId: 'r1' }, ctx);
    await pi.fire('auto_retry_start', { attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: 'overloaded' }, ctx);
    await pi.fire('session_before_compact', {}, ctx);
    await pi.fire('agent_end', { willContinue: true, messages: [] }, ctx);
    await pi.fire(
      'agent_end',
      {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'All done.' }] },
        ],
      },
      ctx,
    );
    await pi.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'boom', content: [] }] }, ctx);
    await pi.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }] }, ctx);
    await pi.fire('session_shutdown', {}, ctx);

    const p = payloads();
    expect(p.map((x) => x.type)).toEqual([
      'session_start',
      'prompt',
      'tool_start',
      'tool_start',
      'blocked',
      'unblocked',
      'blocked',
      'unblocked',
      'blocked',
      'blocked',
      'unblocked',
      'tool_start',
      'compact',
      'turn_done',
      'error',
      'interrupt',
      'session_end',
    ]);
    expect(p.every((x) => x.sessionId === 'S1')).toBe(true);
    expect(p[0]).toEqual({
      type: 'session_start',
      sessionId: 'S1',
      source: 'start',
      agentId: 'Main',
      cwd: '/work/proj',
      hasUI: true,
      model: 'claude-test',
    });
    expect(p[1]?.text).toHaveLength(200);
    expect(String(p[1]?.text).startsWith('fix the bug\n')).toBe(true);
    expect(p[2]).toEqual({ type: 'tool_start', sessionId: 'S1', tool: 'bash', summary: 'npm test --watch' });
    expect(p[3]).toMatchObject({ tool: 'read', summary: 'src/a.ts' });
    expect(p[4]).toEqual({ type: 'blocked', sessionId: 'S1', kind: 'question', msg: 'Which DB?' });
    expect(p[5]).toEqual({ type: 'unblocked', sessionId: 'S1', kind: 'question' });
    expect(p[6]).toEqual({ type: 'blocked', sessionId: 'S1', kind: 'permission', msg: 'rm -rf build' });
    expect(p[7]).toEqual({ type: 'unblocked', sessionId: 'S1', kind: 'permission' });
    expect(p[8]).toMatchObject({ kind: 'permission', msg: 'write' });
    expect(p[9]).toMatchObject({ kind: 'question', msg: 'plan review' });
    expect(p[10]).toEqual({ type: 'unblocked', sessionId: 'S1', kind: 'question' });
    expect(p[11]).toEqual({ type: 'tool_start', sessionId: 'S1', tool: 'retry', summary: '1/3: overloaded' });
    expect(p[13]).toEqual({ type: 'turn_done', sessionId: 'S1', text: 'All done.' });
    expect(p[14]).toEqual({ type: 'error', sessionId: 'S1', text: 'boom' });
    expect(p[16]).toEqual({ type: 'session_end', sessionId: 'S1', reason: 'shutdown' });

    // Envelope + transport.
    const envs = sent();
    expect(new Set(envs.map((e) => e.id)).size).toBe(envs.length);
    for (const e of envs) {
      expect(e.v).toBe(1);
      expect(e.agent).toBe('omp');
      expect(Number.isInteger(e.ts)).toBe(true);
      expect(e.pid).toBe(process.pid);
      expect(typeof e.hostname).toBe('string');
      expect(e.env).toEqual({ herdr_pane_id: 'wS:p1', herdr_workspace_id: 'wS' });
    }
    for (const c of calls) {
      expect(c.url).toBe(`${ENDPOINT}/api/ingest`);
      expect(c.init.method).toBe('POST');
      const h = c.init.headers as Record<string, string>;
      expect(h.authorization).toBe(`Bearer ${TOKEN}`);
      expect(h['content-type']).toBe('application/json');
      expect(JSON.parse(String(c.init.body)).length).toBeLessThanOrEqual(100);
    }
  });

  test('tool_start is throttled to one per session per 2 s', async () => {
    const pi = await setup();
    const ctx = mainCtx('S1');
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await pi.fire('session_start', {}, ctx);
    await pi.fire('tool_execution_start', { toolName: 'bash', args: { command: 'a' } }, ctx);
    now.mockReturnValue(1_001_999);
    await pi.fire('tool_execution_start', { toolName: 'bash', args: { command: 'b' } }, ctx);
    // ask is never throttled
    await pi.fire('tool_execution_start', { toolName: 'ask', args: { questions: [] } }, ctx);
    now.mockReturnValue(1_002_000);
    await pi.fire('tool_execution_start', { toolName: 'bash', args: { command: 'c' } }, ctx);
    await pi.fire('session_shutdown', {}, ctx);
    const tools = payloads().filter((p) => p.type === 'tool_start');
    expect(tools.map((p) => p.summary)).toEqual(['a', 'c']);
    expect(payloads().find((p) => p.type === 'blocked')?.msg).toBe('waiting for user input');
  });

  test('session_switch ends the old card and starts a new one', async () => {
    const pi = await setup();
    let sid = 'S1';
    const ctx = mainCtx('', { sessionManager: { getSessionId: () => sid } });
    await pi.fire('session_start', {}, ctx);
    sid = 'S2';
    await pi.fire('session_switch', { reason: 'new', previousSessionFile: '/x' }, ctx);
    await pi.fire('before_agent_start', { reason: 'prompt', prompt: 'next' }, ctx);
    await pi.fire('session_shutdown', {}, ctx);
    expect(payloads().map((p) => [p.type, p.sessionId, p.reason ?? p.source ?? ''])).toEqual([
      ['session_start', 'S1', 'start'],
      ['session_end', 'S1', 'switch'],
      ['session_start', 'S2', 'switch'],
      ['prompt', 'S2', ''],
      ['session_end', 'S2', 'shutdown'],
    ]);
  });

  test('session_branch (/branch, /fork, /btw mint a new id) ends the old card and starts the new one', async () => {
    const pi = await setup();
    let sid = 'S1';
    const ctx = mainCtx('', { sessionManager: { getSessionId: () => sid } });
    await pi.fire('session_start', {}, ctx);
    await pi.fire('before_agent_start', { reason: 'prompt', prompt: 'first' }, ctx);
    sid = 'S2';
    await pi.fire('session_branch', { reason: 'fork', previousSessionFile: '/x' }, ctx);
    // A subagent spawned after the branch folds into the new root.
    const sub = subCtx('SUB1', '0-Explore', 'explore', 'Main');
    await pi.fire('session_start', {}, sub);
    await pi.fire('agent_start', {}, sub);
    await pi.fire('before_agent_start', { reason: 'prompt', prompt: 'second' }, ctx);
    await pi.fire('session_shutdown', {}, ctx);
    expect(payloads().map((p) => [p.type, p.sessionId, p.reason ?? p.source ?? ''])).toEqual([
      ['session_start', 'S1', 'start'],
      ['prompt', 'S1', ''],
      ['session_end', 'S1', 'branch'],
      ['session_start', 'S2', 'branch'],
      ['subagent_start', 'S2', ''],
      ['prompt', 'S2', ''],
      ['session_end', 'S2', 'shutdown'],
    ]);
    expect(payloads()[3]).toMatchObject({ cwd: '/work/proj', model: 'claude-test' });
  });

  test('session id changes without any switch/branch event: treated as a switch', async () => {
    const pi = await setup();
    let sid = 'S1';
    const ctx = mainCtx('', { sessionManager: { getSessionId: () => sid } });
    await pi.fire('session_start', {}, ctx);
    sid = 'S2';
    await pi.fire('tool_execution_start', { toolName: 'bash', args: { command: 'ls' } }, ctx);
    await pi.fire('session_shutdown', {}, ctx);
    expect(payloads().map((p) => [p.type, p.sessionId, p.reason ?? p.source ?? ''])).toEqual([
      ['session_start', 'S1', 'start'],
      ['session_end', 'S1', 'switch'],
      ['session_start', 'S2', 'switch'],
      ['tool_start', 'S2', ''],
      ['session_end', 'S2', 'shutdown'],
    ]);
  });

  test('loaded mid-session (no session_start seen): first event announces the session', async () => {
    const pi = await setup();
    const ctx = mainCtx('S9');
    await pi.fire('agent_start', {}, ctx);
    await pi.fire('tool_execution_start', { toolName: 'grep', args: { pattern: 'TODO' } }, ctx);
    await pi.fire('session_shutdown', {}, ctx);
    expect(payloads().map((p) => p.type)).toEqual(['session_start', 'tool_start', 'session_end']);
  });

  test('JFM_REDACT=1 blanks prompt, tool summary, question and reply text', async () => {
    vi.stubEnv('JFM_REDACT', '1');
    const pi = await setup();
    const ctx = mainCtx('S1');
    await pi.fire('session_start', {}, ctx);
    await pi.fire('before_agent_start', { reason: 'prompt', prompt: 'secret prompt' }, ctx);
    await pi.fire('tool_execution_start', { toolName: 'bash', args: { command: 'cat .env' } }, ctx);
    await pi.fire('tool_execution_start', { toolName: 'ask', args: { questions: [{ question: 'secret?' }] } }, ctx);
    await pi.fire('tool_approval_requested', { toolName: 'bash', reason: 'curl secret' }, ctx);
    await pi.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'secret reply' }] }] }, ctx);
    await pi.fire('session_shutdown', {}, ctx);
    const body = calls.map((c) => String(c.init.body)).join('\n');
    expect(body).not.toMatch(/secret|\.env/);
    const p = payloads();
    expect(p.find((x) => x.type === 'prompt')?.text).toBe('');
    expect(p.find((x) => x.type === 'tool_start')).toMatchObject({ tool: 'bash', summary: '' });
    expect(p.find((x) => x.type === 'blocked' && x.kind === 'permission')?.msg).toBe('bash');
    expect(p.find((x) => x.type === 'turn_done')?.text).toBe('');
  });
});

describe('subagents (T12: same process, root via globalThis registry)', () => {
  test('sub events fold into the root session with agentType prefix', async () => {
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 5_000));
    const mod = await load();
    const mainPi = new FakePi();
    mod.default(mainPi);
    const main = mainCtx('ROOT');
    await mainPi.fire('session_start', {}, main);

    // omp re-invokes the factory for every child session.
    const subPi = new FakePi();
    mod.default(subPi);
    const sub = subCtx('CHILD-1', '0-Explore', 'explore', 'Main');
    await subPi.fire('session_start', {}, sub);
    await subPi.fire('before_agent_start', { reason: 'prompt', prompt: 'explore the repo' }, sub);
    await subPi.fire('agent_start', {}, sub);
    await subPi.fire('agent_start', {}, sub); // continuation: no duplicate start
    await subPi.fire('tool_execution_start', { toolName: 'grep', args: { pattern: 'foo' } }, sub);
    await subPi.fire('tool_execution_start', { toolName: 'ask', args: { questions: [{ question: 'q' }] } }, sub);
    await subPi.fire('tool_approval_requested', { toolName: 'bash', reason: 'npm i' }, sub);
    await subPi.fire('tool_approval_resolved', { toolName: 'bash' }, sub);
    await subPi.fire('agent_end', { willContinue: true, messages: [] }, sub);
    await subPi.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop', content: 'sub reply' }] }, sub);
    await subPi.fire('session_shutdown', {}, sub); // no duplicate stop, no session_end

    // Nested: a subagent spawned by the subagent resolves through its parent.
    const nestedPi = new FakePi();
    mod.default(nestedPi);
    const nested = subCtx('CHILD-2', '0-Explore.0-Task', 'task', '0-Explore');
    await nestedPi.fire('session_start', {}, nested);
    await nestedPi.fire('agent_start', {}, nested);
    await nestedPi.fire('session_shutdown', {}, nested); // stop on shutdown when agent_end never came

    await mainPi.fire('session_shutdown', {}, main);

    const p = payloads();
    expect(p.every((x) => x.sessionId === 'ROOT')).toBe(true);
    expect(p.map((x) => [x.type, x.agentType ?? ''])).toEqual([
      ['session_start', ''],
      ['subagent_start', 'explore'],
      ['tool_start', 'explore'],
      ['tool_start', 'explore'],
      ['blocked', 'explore'],
      ['unblocked', 'explore'],
      ['subagent_stop', 'explore'],
      ['subagent_start', 'task'],
      ['subagent_stop', 'task'],
      ['session_end', ''],
    ]);
    expect(p[1]).toEqual({ type: 'subagent_start', sessionId: 'ROOT', agentId: '0-Explore', agentType: 'explore' });
    // ask inside a subagent is just a tool line (the user is not asked).
    expect(p[3]).toMatchObject({ type: 'tool_start', tool: 'ask' });
    expect(p[7]).toMatchObject({ agentId: '0-Explore.0-Task' });
  });

  test('a fresh module instance (isolated task / reload re-import) still finds the root', async () => {
    const first = await load();
    const mainPi = new FakePi();
    first.default(mainPi);
    await mainPi.fire('session_start', {}, mainCtx('ROOT'));

    vi.resetModules(); // omp imports with ?mtime=N -> new module instance, same process
    const second = await load({ reset: false });
    expect(second).not.toBe(first);
    const subPi = new FakePi();
    second.default(subPi);
    const sub = subCtx('CHILD', '1-Task', 'task', 'Main');
    await subPi.fire('session_start', {}, sub);
    await subPi.fire('agent_start', {}, sub);
    await subPi.fire('tool_execution_start', { toolName: 'bash', args: { command: 'ls' } }, sub);
    await subPi.fire('agent_end', { messages: [] }, sub);
    await subPi.fire('session_shutdown', {}, sub);
    await mainPi.fire('session_shutdown', {}, mainCtx('ROOT'));

    const subEvents = payloads().filter((p) => p.agentType === 'task');
    expect(subEvents.map((p) => [p.type, p.sessionId])).toEqual([
      ['subagent_start', 'ROOT'],
      ['tool_start', 'ROOT'],
      ['subagent_stop', 'ROOT'],
    ]);
  });

  test('fallback: no root in this process -> only subagent_start/stop on own id with parentId', async () => {
    const pi = await setup();
    const sub = subCtx('CHILD', '0-Plan', 'plan', 'Main');
    await pi.fire('session_start', {}, sub);
    await pi.fire('agent_start', {}, sub);
    await pi.fire('tool_execution_start', { toolName: 'bash', args: { command: 'ls' } }, sub);
    await pi.fire('agent_end', { messages: [] }, sub);
    await pi.fire('session_shutdown', {}, sub);
    await vi.waitFor(() => expect(payloads()).toHaveLength(2));
    expect(payloads()).toEqual([
      { type: 'subagent_start', sessionId: 'CHILD', agentId: '0-Plan', agentType: 'plan', parentId: 'Main' },
      { type: 'subagent_stop', sessionId: 'CHILD', agentId: '0-Plan', agentType: 'plan', parentId: 'Main' },
    ]);
  });
});

describe('transport', () => {
  test('retries 5xx / network errors twice, then succeeds', async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      n += 1;
      if (n === 1) return new Response('', { status: 503 });
      if (n === 2) throw new TypeError('fetch failed');
      return okResponse();
    });
    const pi = await setup();
    await pi.fire('session_start', {}, mainCtx('S1'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await pi.fire('session_shutdown', {}, mainCtx('S1'));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('gives up after 1 + 2 attempts; 401 is not retried', async () => {
    let status = 500;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status });
    });
    const pi = await setup();
    await pi.fire('session_start', {}, mainCtx('S1'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    status = 401;
    await pi.fire('before_agent_start', { reason: 'prompt', prompt: 'x' }, mainCtx('S1'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('events queued while a request is in flight go out as one batch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (first) {
        first = false;
        await gate;
      }
      return okResponse();
    });
    const pi = await setup();
    const ctx = mainCtx('S1');
    await pi.fire('session_start', {}, ctx);
    for (let i = 0; i < 5; i += 1) await pi.fire('before_agent_start', { reason: 'prompt', prompt: `p${i}` }, ctx);
    release();
    await pi.fire('session_shutdown', {}, ctx);
    expect(calls.map((c) => JSON.parse(String(c.init.body)).length)).toEqual([1, 6]);
  });

  test('session_shutdown waits <= 2 s, then aborts: no request left pending', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      signals.push(init.signal as AbortSignal);
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const pi = await setup();
    const ctx = mainCtx('S1');
    await pi.fire('session_start', {}, ctx);
    const started = performance.now();
    await pi.fire('session_shutdown', {}, ctx);
    const ms = performance.now() - started;
    expect(ms).toBeGreaterThanOrEqual(1_900);
    expect(ms).toBeLessThan(2_900);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
    const before = fetchMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 600));
    expect(fetchMock.mock.calls.length).toBe(before); // no retries after shutdown
  });

  test('session_shutdown returns immediately when the queue is already empty', async () => {
    const pi = await setup();
    const ctx = mainCtx('S1');
    await pi.fire('session_start', {}, ctx);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const started = performance.now();
    await pi.fire('session_shutdown', {}, ctx);
    expect(performance.now() - started).toBeLessThan(500);
    expect(payloads().at(-1)).toMatchObject({ type: 'session_end' });
  });
});
