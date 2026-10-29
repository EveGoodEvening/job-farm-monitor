// jfm-emit tests (T30). Every case runs under dash and bash.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  EMIT,
  LOCAL_DIR,
  cleanEnv,
  cleanupHome,
  hasCommand,
  outboxFiles,
  run,
  stateDir,
  tempHome,
  waitFor,
} from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';

const TOKEN = 'test-write-token-0123456789';
const SHELLS = ['dash', 'bash'].filter(hasCommand);

const hook = (event, extra = {}) =>
  JSON.stringify({
    hook_event_name: event,
    session_id: 'sess-1',
    cwd: '/work/proj',
    transcript_path: '/tmp/t.jsonl',
    ...extra,
  });

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readLog = (home) => {
  const p = join(stateDir(home), 'emit.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

test('jfm-emit passes sh -n / dash -n / bash -n', async () => {
  for (const sh of ['sh', ...SHELLS]) {
    const r = await run(sh, ['-n', EMIT]);
    assert.equal(r.code, 0, `${sh} -n: ${r.stderr}`);
  }
});

for (const sh of SHELLS) {
  describe(`jfm-emit under ${sh}`, () => {
    /** @type {Awaited<ReturnType<typeof startMockServer>>} */
    let server;
    before(async () => {
      server = await startMockServer();
    });
    after(async () => {
      await server.close();
    });

    const setup = (status = 200) => {
      server.state.status = status;
      server.state.delayMs = 0;
      server.state.decide = null;
      server.state.requests.length = 0;
      const home = tempHome();
      const env = (extra = {}) =>
        cleanEnv(home, { JFM_ENDPOINT: server.url, JFM_WRITE_TOKEN: TOKEN, ...extra });
      const emit = (agent, input, extra = {}) => run(sh, [EMIT, agent], { env: env(extra), input });
      return { home, env, emit };
    };

    test('delivers an envelope in the background', async () => {
      const { home, emit } = setup();
      try {
        const r = await emit(
          'claude',
          hook('PreToolUse', {
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            tool_response: { stdout: 'big output' },
          }),
          { HERDR_PANE_ID: 'wS:p1', HERDR_TAB_ID: '', TMUX_PANE: '%3' },
        );
        assert.equal(r.code, 0);
        assert.equal(r.stdout, '', 'hooks must print nothing');
        assert.ok(r.ms < 1000, `took ${r.ms}ms`);
        await waitFor(() => server.accepted().length === 1, { what: 'delivery' });
        const req = server.state.requests[0];
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/api/ingest');
        assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
        assert.match(String(req.headers['content-type']), /application\/json/);
        const [env] = /** @type {any[]} */ (server.accepted());
        assert.equal(env.v, 1);
        assert.equal(env.agent, 'claude');
        assert.equal(typeof env.id, 'string');
        assert.ok(env.id.length > 8);
        assert.ok(Number.isInteger(env.ts) && Math.abs(env.ts - Date.now()) < 60_000);
        assert.equal(typeof env.hostname, 'string');
        assert.ok(Number.isInteger(env.pid));
        assert.deepEqual(env.env, { herdr_pane_id: 'wS:p1', tmux_pane: '%3' });
        assert.equal(env.payload.hook_event_name, 'PreToolUse');
        assert.equal(env.payload.session_id, 'sess-1');
        assert.deepEqual(env.payload.tool_input, { command: 'npm test' });
        assert.equal('tool_response' in env.payload, false, 'tool_response is never uploaded');
        await waitFor(() => outboxFiles(home).length === 0, { what: 'outbox drained' });
      } finally {
        await cleanupHome(home);
      }
    });

    test('keeps the outbox when the server fails and flushes it on the next call', async () => {
      const { home, emit } = setup(500);
      try {
        await emit('codex', hook('SessionStart', { source: 'startup' }));
        await waitFor(() => server.state.requests.length === 1, { what: 'failed POST' });
        await waitFor(() => !existsSync(join(stateDir(home), 'lock.d')), { what: 'lock released' });
        assert.equal(outboxFiles(home).length, 1);
        assert.match(readLog(home), /HTTP 500/);

        server.state.status = 200;
        await emit('codex', hook('UserPromptSubmit', { prompt: 'hello' }));
        await waitFor(() => server.accepted().length === 2, { what: 'retry delivery' });
        const events = server.accepted().map((e) => /** @type {any} */ (e).payload.hook_event_name);
        assert.deepEqual(events, ['SessionStart', 'UserPromptSubmit'], 'oldest first, one batch');
        await waitFor(() => outboxFiles(home).length === 0, { what: 'outbox drained' });
      } finally {
        await cleanupHome(home);
      }
    });

    test('stops on 401 and keeps the queue', async () => {
      const { home, env, emit } = setup(401);
      try {
        await emit('claude', hook('SessionStart'), { JFM_NO_FLUSH: '1' });
        await emit('claude', hook('UserPromptSubmit', { prompt: 'x' }), { JFM_NO_FLUSH: '1' });
        assert.equal(outboxFiles(home).length, 2);
        const r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 1);
        assert.equal(server.state.requests.length, 1, 'no retry loop after 401');
        assert.equal(outboxFiles(home).length, 2);
        assert.match(readLog(home), /rejected the write token \(HTTP 401\)/);
        assert.equal(readLog(home).includes(TOKEN), false, 'token never logged');
      } finally {
        await cleanupHome(home);
      }
    });

    test('caps the outbox at 500 files (oldest dropped) and batches 100 per POST', async () => {
      const { home, env } = setup(500);
      try {
        const outbox = join(stateDir(home), 'outbox');
        mkdirSync(outbox, { recursive: true });
        const base = 1_761_721_234_000;
        for (let i = 0; i < 510; i++) {
          const ts = base + i;
          const envelope = { v: 1, id: `id-${i}`, ts, agent: 'claude', payload: { hook_event_name: 'Stop', session_id: 's' } };
          writeFileSync(join(outbox, `${ts}-${String(i).padStart(8, '0')}.json`), JSON.stringify(envelope) + '\n');
        }
        const r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 1);
        const files = outboxFiles(home);
        assert.equal(files.length, 500);
        assert.equal(files[0], `${base + 10}-00000010.json`, '10 oldest dropped');
        assert.match(readLog(home), /dropping 10 oldest/);
        // The batch fails, then one file alone, then the next alone: server down, stop.
        assert.deepEqual(
          server.state.requests.map((q) => /** @type {any[]} */ (q.json).length),
          [100, 1, 1],
        );
        assert.equal(existsSync(join(outbox, `.fail.${base + 10}-00000010.json`)), false, 'an outage counts no failure');
        const firstBatch = /** @type {any[]} */ (server.state.requests[0].json);
        assert.equal(firstBatch.length, 100);
        assert.equal(firstBatch[0].id, 'id-10');

        server.state.status = 200;
        server.state.requests.length = 0;
        const r2 = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r2.code, 0);
        assert.deepEqual(
          server.state.requests.map((q) => /** @type {any[]} */ (q.json).length),
          [100, 100, 100, 100, 100],
        );
        assert.equal(outboxFiles(home).length, 0);
      } finally {
        await cleanupHome(home);
      }
    });

    test('drops unparsable outbox files instead of blocking the queue', async () => {
      const { home, env } = setup(200);
      try {
        const outbox = join(stateDir(home), 'outbox');
        mkdirSync(outbox, { recursive: true });
        writeFileSync(join(outbox, '1000-aaaa.json'), '{not json');
        writeFileSync(join(outbox, '1001-bbbb.json'), JSON.stringify({ v: 1, id: 'ok', ts: 1001, agent: 'codex', payload: {} }));
        const r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 0);
        assert.deepEqual(server.accepted().map((e) => /** @type {any} */ (e).id), ['ok']);
        assert.equal(outboxFiles(home).length, 0);
        assert.match(readLog(home), /dropped unparsable outbox file 1000-aaaa.json/);
      } finally {
        await cleanupHome(home);
      }
    });

    test('throttles PreToolUse to one per session per 2 s (question tools exempt)', async () => {
      const { home, emit } = setup();
      const q = { JFM_NO_FLUSH: '1' };
      try {
        await emit('claude', hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' } }), q);
        await emit('claude', hook('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x' } }), q);
        assert.equal(outboxFiles(home).length, 1, 'second tool_start within 2 s dropped');
        await emit('claude', hook('PreToolUse', { tool_name: 'Read', session_id: 'other' }), q);
        assert.equal(outboxFiles(home).length, 2, 'throttle is per session');
        await emit('claude', hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }), q);
        assert.equal(outboxFiles(home).length, 3, 'question tools are never throttled');

        const marker = join(stateDir(home), 'markers', 'sess-1.tool');
        writeFileSync(marker, `${Date.now() - 2500}\n`);
        await emit('claude', hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), q);
        assert.equal(outboxFiles(home).length, 4, 'allowed again after 2 s');
      } finally {
        await cleanupHome(home);
      }
    });

    test('blocked marker controls PostToolUse', async () => {
      const { home, emit } = setup();
      const q = { JFM_NO_FLUSH: '1' };
      const marker = join(stateDir(home), 'markers', 'sess-1@main.blocked');
      const count = () => outboxFiles(home).length;
      const rm = { command: ['rm', '-rf', 'x'] };
      try {
        await emit('codex', hook('PostToolUse', { tool_name: 'shell' }), q);
        assert.equal(count(), 0, 'plain PostToolUse is not sent');

        await emit('codex', hook('PermissionRequest', { tool_name: 'shell', tool_input: { ...rm, description: 'why' } }), q);
        assert.equal(count(), 1);
        assert.ok(existsSync(marker), 'PermissionRequest sets the marker');
        await emit('codex', hook('PostToolUse', { tool_name: 'shell', tool_input: rm }), q);
        assert.equal(count(), 2, 'PostToolUse of the blocked call is sent (description ignored)');
        assert.equal(existsSync(marker), false, 'and clears the marker');
        await emit('codex', hook('PostToolUse', { tool_name: 'shell', tool_input: rm }), q);
        assert.equal(count(), 2);

        await emit('codex', hook('PostToolUse', { tool_name: 'request_user_input' }), q);
        assert.equal(count(), 3, 'question-tool PostToolUse is always sent');

        await emit('claude', hook('Notification', { notification_type: 'permission_prompt', message: 'needs permission' }), q);
        assert.ok(existsSync(marker), 'permission_prompt notification sets the marker');
        await emit('claude', hook('UserPromptSubmit', { prompt: 'go on' }), q);
        assert.equal(existsSync(marker), false, 'UserPromptSubmit clears it');

        await emit('claude', hook('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: {} }), q);
        assert.ok(existsSync(marker), 'question PreToolUse sets the marker');
        await emit('claude', hook('Notification', { notification_type: 'idle_prompt', message: 'idle' }), q);
        assert.ok(existsSync(marker), 'other notifications leave it');
        await emit('claude', hook('Stop', { last_assistant_message: 'done' }), q);
        assert.equal(existsSync(marker), false, 'Stop clears it');

        await emit('claude', hook('PermissionRequest', { tool_name: 'Bash' }), q);
        await emit('claude', hook('SessionEnd', { reason: 'exit' }), q);
        assert.equal(existsSync(marker), false, 'SessionEnd clears it');
      } finally {
        await cleanupHome(home);
      }
    });

    test('blocked marker: a parallel tool or a subagent tool does not consume it', async () => {
      const { home, emit } = setup();
      const q = { JFM_NO_FLUSH: '1' };
      const markers = join(stateDir(home), 'markers');
      const main = join(markers, 'sess-1@main.blocked');
      const sub = join(markers, 'sess-1@a-agent7.blocked');
      const dir = join(stateDir(home), 'outbox');
      const sent = () => outboxFiles(home).map((f) => readJson(join(dir, f)).payload);
      const npm = { command: 'npm test', description: 'Run tests' };
      try {
        // (a) Main agent: B waits for approval, parallel auto-allowed A finishes.
        await emit('claude', hook('PermissionRequest', { tool_name: 'Bash', tool_input: npm }), q);
        await emit('claude', hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' } }), q);
        await emit('claude', hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), q);
        assert.equal(sent().length, 1, 'unrelated PostToolUse is not sent');
        assert.ok(existsSync(main), 'and keeps the marker');

        // (b) A subagent tool finishes while main is blocked.
        await emit('claude', hook('PostToolUse', { tool_name: 'Bash', tool_input: npm, agent_id: 'agent7', agent_type: 'Explore' }), q);
        assert.equal(sent().length, 1, 'subagent PostToolUse does not touch the main marker');
        assert.ok(existsSync(main));

        // Approved: main's own PostToolUse is sent and clears the marker.
        await emit('claude', hook('PostToolUse', { tool_name: 'Bash', tool_input: npm, tool_use_id: 't1' }), q);
        assert.equal(sent().length, 2);
        assert.equal(sent()[1].hook_event_name, 'PostToolUse');
        assert.equal(existsSync(main), false);

        // Subagent permission: keyed by agent_id, cleared by that agent's call only.
        await emit('claude', hook('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/x' }, agent_id: 'agent7' }), q);
        assert.ok(existsSync(sub));
        await emit('claude', hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/x' } }), q);
        assert.ok(existsSync(sub), 'main PostToolUse of the same call shape does not clear the subagent marker');
        assert.equal(sent().length, 3, 'not sent either');
        await emit('claude', hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/x' }, agent_id: 'agent7' }), q);
        assert.equal(existsSync(sub), false);
        assert.equal(sent().length, 4);

        // A denied call ends with PostToolUseFailure: always sent, clears its marker.
        await emit('claude', hook('PermissionRequest', { tool_name: 'Bash', tool_input: npm }), q);
        await emit('claude', hook('PostToolUseFailure', { tool_name: 'Bash', tool_input: npm, error: 'denied' }), q);
        assert.equal(existsSync(main), false);
        assert.equal(sent().length, 6);

        // SubagentStop clears its own marker only; Stop clears all of the session.
        await emit('claude', hook('PermissionRequest', { tool_name: 'Bash', tool_input: npm }), q);
        await emit('claude', hook('PermissionRequest', { tool_name: 'Bash', tool_input: npm, agent_id: 'agent7' }), q);
        await emit('claude', hook('SubagentStop', { agent_id: 'agent7', agent_type: 'Explore' }), q);
        assert.equal(existsSync(sub), false);
        assert.ok(existsSync(main));
        await emit('claude', hook('PermissionRequest', { tool_name: 'Bash', tool_input: npm, agent_id: 'agent7' }), q);
        await emit('claude', hook('Stop', {}), q);
        assert.equal(existsSync(main) || existsSync(sub), false);
      } finally {
        await cleanupHome(home);
      }
    });

    test('codex request_user_input_async: unthrottled question, PostToolUse dropped, reply kept', async () => {
      const { home, emit } = setup();
      const q = { JFM_NO_FLUSH: '1' };
      const marker = join(stateDir(home), 'markers', 'sess-1@main.blocked');
      const events = () => outboxFiles(home).length;
      try {
        await emit('codex', hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), q);
        await emit('codex', hook('PreToolUse', { tool_name: 'request_user_input_async', tool_input: { questions: [{ title: 'Which color?' }] } }), q);
        assert.equal(events(), 2, 'question PreToolUse is never throttled');
        assert.ok(existsSync(marker), 'and sets the blocked marker');
        await emit('codex', hook('PostToolUse', { tool_name: 'request_user_input_async' }), q);
        assert.equal(events(), 2, 'its immediate PostToolUse ({accepted:true}) is dropped');
        assert.ok(existsSync(marker), 'and keeps the marker (question still open)');
        await emit('codex', hook('PostToolUse', { tool_name: 'clocksleep' }), q);
        assert.equal(events(), 2, 'other PostToolUse while the question is open is not sent');
        assert.ok(existsSync(marker));
        await emit('codex', hook('UserPromptSubmit', { prompt: '<send_user_message_question_reply>\n[{"answer":"red"}]\n</send_user_message_question_reply>' }), q);
        assert.equal(events(), 3, 'the reply UserPromptSubmit is sent');
        assert.equal(existsSync(marker), false);
      } finally {
        await cleanupHome(home);
      }
    });

    test('JFM_REDACT=1 blanks tool_input, prompt, last_assistant_message, message', async () => {
      const { home, emit } = setup();
      const q = { JFM_NO_FLUSH: '1', JFM_REDACT: '1' };
      try {
        await emit('claude', hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat secret.txt' } }), q);
        await emit('claude', hook('UserPromptSubmit', { session_id: 's2', prompt: 'my secret prompt' }), q);
        await emit('claude', hook('Stop', { session_id: 's3', last_assistant_message: 'secret reply' }), q);
        await emit('claude', hook('Notification', { session_id: 's4', notification_type: 'permission_prompt', message: 'secret msg' }), q);
        const dir = join(stateDir(home), 'outbox');
        const payloads = outboxFiles(home).map((f) => readJson(join(dir, f)).payload);
        assert.equal(payloads.length, 4);
        const byEvent = Object.fromEntries(payloads.map((p) => [p.hook_event_name, p]));
        assert.deepEqual(byEvent.PreToolUse.tool_input, {});
        assert.equal(byEvent.PreToolUse.tool_name, 'Bash', 'tool name kept');
        assert.equal(byEvent.UserPromptSubmit.prompt, '');
        assert.equal(byEvent.Stop.last_assistant_message, '');
        assert.equal(byEvent.Notification.message, '');
        assert.equal(byEvent.Notification.notification_type, 'permission_prompt');
        const all = outboxFiles(home).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
        assert.equal(/secret/.test(all), false);
      } finally {
        await cleanupHome(home);
      }
    });

    test('JFM_REDACT=1 keeps only metadata (no error text, rules, paths, instructions)', async () => {
      const { home, emit } = setup();
      const q = { JFM_NO_FLUSH: '1', JFM_REDACT: '1' };
      const fixtures = join(LOCAL_DIR, '..', 'packages', 'core', 'test', 'fixtures', 'claude');
      try {
        const perm = readFileSync(join(fixtures, 'PermissionRequest.json'), 'utf8');
        await emit('claude', perm, q);
        await emit('claude', hook('PostToolUseFailure', { session_id: 's2', tool_name: 'Bash', tool_input: { command: 'cat ./missing-file.txt' }, error: 'cat: ./missing-file.txt: No such file' }), q);
        await emit('claude', hook('StopFailure', { session_id: 's3', error: 'secret failure text' }), q);
        await emit('claude', hook('PreCompact', { session_id: 's4', trigger: 'manual', custom_instructions: 'secret instructions' }), q);
        await emit('claude', hook('SubagentStop', { session_id: 's5', agent_id: 'ag1', agent_type: 'Explore', agent_transcript_path: '/home/user/secret/t.jsonl', last_assistant_message: 'secret' }), q);
        const dir = join(stateDir(home), 'outbox');
        const raw = outboxFiles(home).map((f) => readFileSync(join(dir, f), 'utf8'));
        assert.equal(raw.length, 5);
        const all = raw.join('\n');
        for (const leak of ['secret', 'missing-file', 'touch perm-test', 'addDirectories', '/home/user', 'transcript', 'acceptEdits']) {
          assert.equal(all.includes(leak), false, `${leak} must not be sent`);
        }
        const byEvent = Object.fromEntries(raw.map((r) => JSON.parse(r).payload).map((p) => [p.hook_event_name, p]));
        assert.deepEqual(byEvent.PermissionRequest.tool_input, {});
        assert.equal(byEvent.PermissionRequest.tool_name, 'Bash');
        assert.equal(byEvent.PermissionRequest.cwd, 'proj', 'cwd reduced to the project name');
        assert.equal(byEvent.PermissionRequest.session_id, '36ee3903-dcea-4455-9f16-3ae2070079a6');
        assert.equal(byEvent.PreCompact.trigger, 'manual');
        assert.equal(byEvent.SubagentStop.agent_id, 'ag1');
        assert.equal(byEvent.SubagentStop.agent_type, 'Explore');
        assert.equal(byEvent.SubagentStop.last_assistant_message, '');
      } finally {
        await cleanupHome(home);
      }
    });

    test('minimizes large prompts and file inputs instead of forwarding their contents', async () => {
      const { home, env, emit } = setup();
      const q = { JFM_NO_FLUSH: '1' };
      try {
        const secret = 'PRIVATE-CONTENT-'.repeat(200_000);
        await emit('claude', hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/work/proj/a.txt', content: secret, description: secret } }), q);
        await emit('claude', hook('UserPromptSubmit', { session_id: 's2', prompt: `\n  \n${'😀'.repeat(130)}\n${secret}`, custom_instructions: secret }), q);
        await emit('claude', hook('PreToolUse', { session_id: 's3', tool_name: 'MultiEdit', tool_input: { file_path: '/work/proj/b.ts', edits: [{ old_string: secret, new_string: secret }], old_string: secret, new_string: secret } }), q);
        await emit('claude', hook('PreToolUse', { session_id: 's4', tool_name: 'mcp__x__y', tool_input: { arbitrary: secret, body: secret } }), q);
        const dir = join(stateDir(home), 'outbox');
        const queued = outboxFiles(home).map((f) => readJson(join(dir, f)).payload);
        const byTool = Object.fromEntries(queued.map((p) => [p.tool_name ?? p.hook_event_name, p]));
        assert.deepEqual(byTool.Write.tool_input, { file_path: '/work/proj/a.txt' });
        assert.deepEqual(byTool.MultiEdit.tool_input, { file_path: '/work/proj/b.ts' });
        assert.equal(byTool.UserPromptSubmit.prompt, '😀'.repeat(120), 'codepoints, not UTF-16 units');
        assert.deepEqual(byTool.mcp__x__y.tool_input, {});
        assert.equal(JSON.stringify(queued).includes('PRIVATE-CONTENT'), false);
        assert.equal(JSON.stringify(queued).includes('transcript'), false);
        const r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 0);
        assert.deepEqual(server.accepted().map((e) => e.payload), queued, 'delivery minimization is idempotent');
      } finally {
        await cleanupHome(home);
      }
    });

    test('keeps bounded useful tool summaries, model identities and control metadata only', async () => {
      const { home, env, emit } = setup();
      const q = { JFM_NO_FLUSH: '1' };
      const cases = [
        ['codex', 'shell', { command: ['bash', '-lc', 'npm test\nPRIVATE-CONTENT'], description: 'Allow tests?', body: 'PRIVATE-CONTENT' }, { command: 'npm test', description: 'Allow tests?' }],
        ['claude', 'Edit', { file_path: '/work/proj/a.ts', old_string: 'PRIVATE-CONTENT', new_string: 'PRIVATE-CONTENT' }, { file_path: '/work/proj/a.ts' }],
        ['claude', 'Grep', { pattern: 'find me\nPRIVATE-CONTENT', path: '/private', output: 'PRIVATE-CONTENT' }, { pattern: 'find me' }],
        ['codex', 'web_search', { query: 'search me', instructions: 'PRIVATE-CONTENT' }, { query: 'search me' }],
        ['codex', 'request_user_input', { questions: [{ title: 'Choose?\nPRIVATE-CONTENT', options: [{ label: 'PRIVATE-CONTENT' }] }, { question: 'PRIVATE-CONTENT' }] }, { question: 'Choose?' }],
        ['codex', 'apply_patch', { input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-PRIVATE-CONTENT\n+PRIVATE-CONTENT\n*** Add File: b.ts\n+PRIVATE-CONTENT\n*** End Patch' }, { input: '*** Update File: a.ts\n*** Add File: b.ts' }],
        ['codex', 'update_plan', { explanation: 'PRIVATE-CONTENT', plan: [{ step: 'PRIVATE-CONTENT', status: 'completed' }, { step: 'Implement fix\nPRIVATE-CONTENT', status: 'in_progress' }, { step: 'PRIVATE-CONTENT', status: 'pending' }] }, { plan: [{ step: 'Implement fix', status: 'in_progress' }] }],
        ['claude', 'unknown', { arbitrary: 'PRIVATE-CONTENT', content: 'PRIVATE-CONTENT', argsPreview: 'bounded preview\nPRIVATE-CONTENT' }, { argsPreview: 'bounded preview' }],
      ];
      try {
        for (const [i, [agent, tool_name, tool_input]] of cases.entries()) {
          await emit(agent, hook('PreToolUse', { session_id: `tool-${i}`, tool_name, tool_input, permission_suggestions: ['PRIVATE-CONTENT'], tool_response: 'PRIVATE-CONTENT', unknown: 'PRIVATE-CONTENT' }), q);
        }
        await emit('claude', hook('SessionStart', { session_id: 'model', model: { id: 'model-id', display_name: 'Model Name', instructions: 'PRIVATE-CONTENT' }, source: 'startup', agent_id: 'ag1', agent_type: 'Explore', stop_hook_active: false }), q);
        await emit('claude', hook('Stop', { session_id: 'reply', last_assistant_message: 'r'.repeat(400) }), q);
        await emit('claude', hook('StopFailure', { session_id: 'failure', error: 'e'.repeat(400) }), q);
        await emit('omp', JSON.stringify({ type: 'blocked', sessionId: 'omp', kind: 'question', msg: 'm'.repeat(400), parentId: 'parent', agentType: 'worker' }), q);
        await emit('omp', JSON.stringify({ type: 'prompt', sessionId: 'omp-prompt', text: '\nTitle\nPRIVATE-CONTENT' }), q);
        await run(sh, [EMIT, '--flush'], { env: env() });
        const payloads = server.accepted().map((e) => e.payload);
        const bySession = Object.fromEntries(payloads.map((p) => [p.session_id ?? p.sessionId, p]));
        for (const [i, [, , , expected]] of cases.entries()) assert.deepEqual(bySession[`tool-${i}`].tool_input, expected);
        assert.deepEqual(bySession.model.model, { id: 'model-id', display_name: 'Model Name' });
        assert.equal(bySession.model.source, 'startup');
        assert.equal(bySession.model.agent_id, 'ag1');
        assert.equal(bySession.model.agent_type, 'Explore');
        assert.equal(bySession.model.stop_hook_active, false);
        assert.equal(bySession.reply.last_assistant_message, 'r'.repeat(300));
        assert.equal(bySession.failure.error, 'e'.repeat(300));
        assert.equal(bySession.omp.msg, 'm'.repeat(300));
        assert.equal(bySession.omp.kind, 'question');
        assert.equal(bySession.omp.parentId, 'parent');
        assert.equal(bySession['omp-prompt'].text, 'Title');
        assert.equal(JSON.stringify(payloads).includes('PRIVATE-CONTENT'), false);
      } finally {
        await cleanupHome(home);
      }
    });

    test('flush minimizes legacy raw envelopes and reapplies current redaction', async () => {
      const { home, env } = setup();
      const outbox = join(stateDir(home), 'outbox');
      const raw = { v: 1, id: 'legacy', ts: 1000, agent: 'claude', payload: JSON.parse(hook('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/work/proj/a.txt', content: 'PRIVATE-CONTENT' }, prompt: 'Title\nPRIVATE-CONTENT', message: 'permission details', error: 'error details', custom_instructions: 'PRIVATE-CONTENT', permission_suggestions: ['PRIVATE-CONTENT'] })) };
      try {
        mkdirSync(outbox, { recursive: true });
        writeFileSync(join(outbox, '1000-legacy.json'), JSON.stringify(raw));
        let r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 0);
        const first = server.accepted()[0].payload;
        assert.deepEqual(first.tool_input, { file_path: '/work/proj/a.txt' });
        assert.equal(first.prompt, 'Title');
        assert.equal(first.message, 'permission details');
        assert.equal(JSON.stringify(first).includes('PRIVATE-CONTENT'), false);
        assert.equal('transcript_path' in first, false);
        // Simulate an old queue surviving until the operator enables redaction.
        server.state.requests.length = 0;
        writeFileSync(join(outbox, '1000-legacy.json'), JSON.stringify(raw));
        r = await run(sh, [EMIT, '--flush'], { env: env({ JFM_REDACT: '1' }) });
        assert.equal(r.code, 0);
        const redacted = server.accepted()[0].payload;
        assert.deepEqual(redacted.tool_input, {});
        assert.equal(redacted.prompt, '');
        assert.equal(redacted.message, '');
        assert.equal(redacted.error, '');
        assert.equal(redacted.cwd, 'proj');
        assert.equal(redacted.tool_name, 'Write');
        assert.equal(redacted.hook_event_name, 'PermissionRequest');
        assert.equal(redacted.session_id, 'sess-1');
        for (const value of ['PRIVATE-CONTENT', '/work/', 'permission details', 'error details', 'transcript']) assert.equal(JSON.stringify(redacted).includes(value), false);
      } finally {
        await cleanupHome(home);
      }
    });

    test('disabled explicit flush leaves the queue and cleanup state untouched, then resumes', async () => {
      const { home, env, emit } = setup();
      try {
        await emit('claude', hook('UserPromptSubmit', { prompt: 'Queued title' }), { JFM_NO_FLUSH: '1' });
        const dir = join(stateDir(home), 'outbox');
        const files = outboxFiles(home);
        const before = files.map((f) => readFileSync(join(dir, f), 'utf8'));
        const marker = join(stateDir(home), 'markers', 'old-marker');
        writeFileSync(marker, 'keep me');
        const old = new Date(Date.now() - 2 * 86400_000);
        utimesSync(marker, old, old);
        const r = await run(sh, [EMIT, '--flush'], { env: env({ JFM_DISABLE: '1' }) });
        assert.equal(r.code, 0);
        assert.equal(server.state.requests.length, 0);
        assert.deepEqual(outboxFiles(home), files);
        assert.deepEqual(files.map((f) => readFileSync(join(dir, f), 'utf8')), before);
        assert.equal(readFileSync(marker, 'utf8'), 'keep me', 'disabled flush does not run cleanup');
        assert.equal(existsSync(join(stateDir(home), 'lock.d')), false);
        assert.equal(existsSync(join(stateDir(home), 'emit.log')), false);
        const resumed = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(resumed.code, 0);
        assert.equal(server.accepted().length, 1);
        assert.equal(server.accepted()[0].payload.prompt, 'Queued title');
        assert.equal(outboxFiles(home).length, 0);
      } finally {
        await cleanupHome(home);
      }
    });

    test('never exits 2 (or prints) when the state dir cannot be written', async () => {
      const { home, env } = setup();
      try {
        const blocker = join(home, 'not-a-dir');
        writeFileSync(blocker, '');
        const e = env({ XDG_STATE_HOME: join(blocker, 'state'), JFM_NO_FLUSH: '1' });
        const inputs = [
          hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }),
          hook('PreToolUse', { tool_name: 'request_user_input', tool_input: {} }),
          hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
          hook('Notification', { notification_type: 'permission_prompt', message: 'm' }),
          hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
          hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
          hook('SessionEnd', { reason: 'exit' }),
        ];
        for (const input of inputs) {
          const r = await run(sh, [EMIT, 'claude'], { env: e, input });
          assert.equal(r.code, 0, `exit ${r.code} for ${input.slice(0, 60)}: ${r.stderr}`);
          assert.equal(r.stderr, '');
          assert.equal(r.stdout, '');
        }
      } finally {
        await cleanupHome(home);
      }
    });

    const writeEnvelopes = (home, n, { pad = 0, base = 1_761_721_234_000, prefix = 'id' } = {}) => {
      const outbox = join(stateDir(home), 'outbox');
      mkdirSync(outbox, { recursive: true });
      const names = [];
      for (let i = 0; i < n; i++) {
        const ts = base + i;
        const envelope = { v: 1, id: `${prefix}-${i}`, ts, agent: 'claude', payload: { hook_event_name: 'Stop', session_id: 's', pad: 'p'.repeat(pad) } };
        const name = `${ts}-${String(i).padStart(8, '0')}.json`;
        writeFileSync(join(outbox, name), JSON.stringify(envelope) + '\n');
        names.push(name);
      }
      return names;
    };

    test('bounds POST sizes while delivering and minimizing large legacy queued envelopes', async () => {
      const { home, env } = setup(200);
      try {
        writeEnvelopes(home, 60, { pad: 50_000 });
        const r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 0);
        const sizes = server.state.requests.map((q) => Buffer.byteLength(q.body));
        for (const b of sizes) assert.ok(b <= 1_000_000 + 60_000, `POST of ${b} bytes`);
        assert.equal(server.accepted().length, 60);
        assert.equal(server.accepted().some((e) => 'pad' in e.payload), false, 'legacy arbitrary fields are removed before upload');
        assert.deepEqual(server.accepted().map((e) => /** @type {any} */ (e).id), Array.from({ length: 60 }, (_, i) => `id-${i}`), 'order kept');
        assert.equal(outboxFiles(home).length, 0);
      } finally {
        await cleanupHome(home);
      }
    });

    test('one bad envelope does not block the queue: 413 set aside, 500 counted then set aside', async () => {
      const { home, env } = setup(200);
      const rejected = join(stateDir(home), 'rejected');
      const ids = (q) => (Array.isArray(q.json) ? q.json.map((e) => e.id) : []);
      try {
        // 413 for any request containing "huge": the batch fails, then the lone file is set aside.
        server.state.decide = (json) => (ids({ json }).includes('huge-0') ? 413 : undefined);
        writeEnvelopes(home, 1, { prefix: 'huge', base: 1000 });
        writeEnvelopes(home, 3, { base: 2000 });
        let r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 0);
        assert.deepEqual(server.accepted().map((e) => /** @type {any} */ (e).id), ['id-0', 'id-1', 'id-2']);
        assert.deepEqual(readdirSync(rejected), ['1000-00000000.json']);
        assert.equal(outboxFiles(home).length, 0);
        assert.match(readLog(home), /set aside 1000-00000000.json \(HTTP 413\)/);

        // 500 for the poison file only: newer events still go through on every run; the
        // poison file is set aside after 3 runs where it failed alone and others passed.
        server.state.requests.length = 0;
        server.state.decide = (json) => (ids({ json }).includes('poison-0') ? 500 : undefined);
        writeEnvelopes(home, 1, { prefix: 'poison', base: 3000 });
        for (let run_ = 0; run_ < 3; run_++) {
          writeEnvelopes(home, 1, { prefix: `new${run_}`, base: 4000 + run_ });
          r = await run(sh, [EMIT, '--flush'], { env: env() });
          assert.equal(server.accepted().some((e) => /** @type {any} */ (e).id === `new${run_}-0`), true, `run ${run_}: newer event delivered`);
        }
        assert.equal(outboxFiles(home).length, 0);
        assert.ok(readdirSync(rejected).includes('3000-00000000.json'));
        // The poison file is small, so no multi-MB re-uploads: each run sends it twice at most.
        const poisonPosts = server.state.requests.filter((q) => ids(q).includes('poison-0')).length;
        assert.ok(poisonPosts <= 6, `${poisonPosts} POSTs carried the poison file`);
      } finally {
        await cleanupHome(home);
      }
    });

    test('reads the config file; environment variables win', async () => {
      const { home } = setup();
      try {
        const cfgDir = join(home, '.config', 'job-farm-monitor');
        mkdirSync(cfgDir, { recursive: true });
        writeFileSync(
          join(cfgDir, 'config'),
          [
            '# comment',
            `JFM_ENDPOINT='${server.url}/'`,
            `export JFM_WRITE_TOKEN="${TOKEN}"`,
            'JFM_REDACT=1',
            'EVIL=$(touch /tmp/should-not-run)',
            '',
          ].join('\n'),
          { mode: 0o600 },
        );
        const env = cleanEnv(home, { JFM_NO_FLUSH: '1' });
        await run(sh, [EMIT, 'claude'], { env, input: hook('UserPromptSubmit', { prompt: 'p' }) });
        const dir = join(stateDir(home), 'outbox');
        let files = outboxFiles(home);
        assert.equal(files.length, 1, 'configured from the file');
        assert.equal(readJson(join(dir, files[0])).payload.prompt, '', 'JFM_REDACT from the file');

        await run(sh, [EMIT, 'claude'], { env: { ...env, JFM_REDACT: '' }, input: hook('UserPromptSubmit', { session_id: 'b', prompt: 'p2' }) });
        files = outboxFiles(home);
        const prompts = files.map((f) => readJson(join(dir, f)).payload.prompt).sort();
        assert.deepEqual(prompts, ['', 'p2'], 'empty env JFM_REDACT overrides the file');

        const r = await run(sh, [EMIT, '--flush'], { env: cleanEnv(home) });
        assert.equal(r.code, 0);
        assert.equal(server.accepted().length, 2, 'trailing slash in endpoint handled');
        assert.equal(server.state.requests[0].headers.authorization, `Bearer ${TOKEN}`);
      } finally {
        await cleanupHome(home);
      }
    });

    test('--check posts [] and prints status + body', async () => {
      const { home, env } = setup(200);
      try {
        const r = await run(sh, [EMIT, '--check'], { env: env() });
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /HTTP 200 \{"accepted":0,"ignored":0,"revision":1\}/);
        assert.match(r.stdout, new RegExp(`endpoint: ${server.url}/api/ingest`));
        assert.equal(server.state.requests[0].body, '[]');
        assert.equal(r.stdout.includes(TOKEN) || r.stderr.includes(TOKEN), false);

        server.state.status = 401;
        const bad = await run(sh, [EMIT, '--check'], { env: env() });
        assert.equal(bad.code, 1);
        assert.match(bad.stdout, /HTTP 401 \{"error":"unauthorized"\}/);

        const none = await run(sh, [EMIT, '--check'], { env: cleanEnv(home) });
        assert.equal(none.code, 2);
        assert.match(none.stderr, /JFM_ENDPOINT and JFM_WRITE_TOKEN must be set/);
      } finally {
        await cleanupHome(home);
      }
    });

    test('returns in well under 1 s even when the server hangs (SessionEnd path)', async () => {
      const { home, emit } = setup(200);
      server.state.delayMs = 3000;
      try {
        const times = [];
        for (const ev of ['SessionEnd', 'PreToolUse', 'Stop']) {
          const r = await emit('codex', hook(ev, { session_id: `t-${ev}`, tool_name: 'shell' }));
          assert.equal(r.code, 0);
          times.push(r.ms);
        }
        for (const ms of times) assert.ok(ms < 1000, `call took ${ms}ms`);
        await waitFor(() => server.state.requests.length >= 1, { what: 'background POST' });
      } finally {
        server.state.delayMs = 0;
        await waitFor(() => !existsSync(join(stateDir(home), 'lock.d')), { what: 'slow flush done' }).catch(() => {});
        await cleanupHome(home);
      }
    });

    test('disabled, unconfigured, invalid input and bad usage never fail the hook', async () => {
      const { home, emit } = setup();
      try {
        let r = await emit('claude', hook('SessionStart'), { JFM_DISABLE: '1' });
        assert.equal(r.code, 0);
        r = await run(sh, [EMIT, 'claude'], { env: cleanEnv(home), input: hook('SessionStart') });
        assert.equal(r.code, 0);
        assert.equal(outboxFiles(home).length, 0);

        r = await emit('claude', '{not json', { JFM_NO_FLUSH: '1' });
        assert.equal(r.code, 0);
        r = await emit('claude', '[1,2]', { JFM_NO_FLUSH: '1' });
        assert.equal(r.code, 0);
        r = await emit('claude', '', { JFM_NO_FLUSH: '1' });
        assert.equal(r.code, 0);
        assert.equal(outboxFiles(home).length, 0);
        assert.match(readLog(home), /skipped invalid hook payload/);

        r = await run(sh, [EMIT, 'nope'], { env: cleanEnv(home), input: '{}' });
        assert.notEqual(r.code, 0);
        assert.notEqual(r.code, 2, 'exit 2 would block a Claude tool call');
        assert.match(r.stderr, /usage/);
      } finally {
        await cleanupHome(home);
      }
    });

    test('--record / JFM_RECORD_DIR saves raw stdin as <agent>-<event>-<ms>.json', async () => {
      const { home } = setup();
      try {
        const raw = hook('PostToolUse', { tool_name: 'Bash', tool_response: { stdout: 'kept in record' } });
        const recDir = join(home, 'rec');
        // Recording works without any endpoint configured.
        let r = await run(sh, [EMIT, 'claude'], { env: cleanEnv(home, { JFM_RECORD_DIR: recDir }), input: raw });
        assert.equal(r.code, 0);
        const recs = readdirSync(recDir);
        assert.equal(recs.length, 1);
        assert.match(recs[0], /^claude-PostToolUse-\d{13}\.json$/);
        assert.equal(readFileSync(join(recDir, recs[0]), 'utf8').trim(), raw);
        assert.equal(outboxFiles(home).length, 0);

        r = await run(sh, [EMIT, '--record', 'codex'], { env: cleanEnv(home), input: hook('Interrupt') });
        assert.equal(r.code, 0);
        const def = readdirSync(join(stateDir(home), 'record'));
        assert.equal(def.length, 1);
        assert.match(def[0], /^codex-Interrupt-\d{13}\.json$/);

        r = await run(sh, [EMIT, 'codex'], { env: cleanEnv(home, { JFM_RECORD_DIR: recDir }), input: '{bad' });
        assert.equal(r.code, 0);
        assert.ok(readdirSync(recDir).some((f) => /^codex-invalid-\d{13}\.json$/.test(f)), 'invalid input recorded too');
      } finally {
        await cleanupHome(home);
      }
    });

    test('lock: a fresh lock defers, a stale (>60 s) lock is taken over', async () => {
      const { home, env, emit } = setup(200);
      try {
        await emit('omp', JSON.stringify({ type: 'session_start', sessionId: 'o1' }), { JFM_NO_FLUSH: '1' });
        const lock = join(stateDir(home), 'lock.d');
        mkdirSync(lock);
        let r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 0);
        assert.equal(server.state.requests.length, 0, 'another flusher holds the lock');
        assert.equal(outboxFiles(home).length, 1);

        const old = new Date(Date.now() - 120_000);
        utimesSync(lock, old, old);
        r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 0);
        assert.equal(server.accepted().length, 1);
        assert.equal(/** @type {any} */ (server.accepted()[0]).payload.sessionId, 'o1');
        assert.equal(existsSync(lock), false, 'lock released');
        assert.match(readLog(home), /removing stale lock/);
      } finally {
        await cleanupHome(home);
      }
    });

    test('lock: a stale lock is taken over by exactly one of many concurrent flushers', async () => {
      const { home, env } = setup(200);
      try {
        writeEnvelopes(home, 20);
        const lock = join(stateDir(home), 'lock.d');
        mkdirSync(lock);
        writeFileSync(join(lock, 'pid'), '999999999\n');
        const old = new Date(Date.now() - 120_000);
        utimesSync(lock, old, old);
        server.state.delayMs = 300;
        await Promise.all(Array.from({ length: 8 }, () => run(sh, [EMIT, '--flush'], { env: env() })));
        assert.equal(server.state.requests.length, 1, 'one flusher sent one batch');
        assert.equal(server.accepted().length, 20);
        assert.equal(outboxFiles(home).length, 0);
        assert.equal(existsSync(lock), false);
        assert.equal(existsSync(join(stateDir(home), 'lock.steal.d')), false);
        const leftovers = readdirSync(join(stateDir(home), 'outbox')).filter((f) => f.startsWith('.batch'));
        assert.deepEqual(leftovers, []);
      } finally {
        server.state.delayMs = 0;
        await cleanupHome(home);
      }
    });

    test('lock: a stale lock whose owner is still alive is kept (up to 10 min)', async () => {
      const { home, env } = setup(200);
      try {
        writeEnvelopes(home, 1);
        const lock = join(stateDir(home), 'lock.d');
        mkdirSync(lock);
        writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
        let old = new Date(Date.now() - 120_000);
        utimesSync(lock, old, old);
        let r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(r.code, 0);
        assert.equal(server.state.requests.length, 0, 'live owner keeps the lock');
        assert.ok(existsSync(lock));
        old = new Date(Date.now() - 11 * 60_000);
        utimesSync(lock, old, old);
        r = await run(sh, [EMIT, '--flush'], { env: env() });
        assert.equal(server.accepted().length, 1, 'taken over after 10 min');
      } finally {
        await cleanupHome(home);
      }
    });
  });
}
