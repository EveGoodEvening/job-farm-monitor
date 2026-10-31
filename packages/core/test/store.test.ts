import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DAY_MS,
  ENDED_RETENTION_MS,
  EVENTS_RETENTION_MS,
  HOUR_MS,
  PROGRESS_CARD,
  PROGRESS_KEEP,
  PURGE_EVERY_REVISIONS,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
  SILENT_HIDE_MS,
  STALE_MS,
  Store,
} from '../src/index.js';
import type { Envelope, SqlDriver, StateOptions } from '../src/types.js';
import { DRIVER_CASES, envelope, fixture } from './helpers.js';

const T0 = 1_761_721_000_000;
const OPTS: StateOptions = { endedWithinMs: HOUR_MS, progressLimit: PROGRESS_CARD };

const claude = (sessionId: string, payload: Record<string, unknown>, over: Partial<Envelope> = {}) =>
  envelope('claude', { ...payload, session_id: sessionId }, { ts: T0, ...over });
const cl = (name: string) => fixture('claude', name);

describe.each(DRIVER_CASES.filter((d) => d.name !== 'node-sqlite (:memory:)'))('Store on $name', (dc) => {
  let driver: SqlDriver;
  let cleanup: () => Promise<void>;
  let clock: number;
  let store: Store;

  beforeEach(async () => {
    ({ driver, cleanup } = await dc.make());
    clock = T0;
    store = new Store(driver, { now: () => clock });
    await store.init();
  });
  afterEach(async () => cleanup());

  async function count(table: string): Promise<number> {
    return Number((await driver.exec(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0]!.c);
  }

  it('init is idempotent and seeds meta', async () => {
    await store.init();
    const { rows } = await driver.exec(`SELECT k, v FROM meta ORDER BY k`);
    expect(rows).toEqual([
      { k: 'revision', v: '0' },
      { k: 'schema_version', v: String(SCHEMA_VERSION) },
    ]);
    expect(await store.state(OPTS)).toEqual({ revision: 0, now: T0, sessions: [] });
  });

  it('ingest builds a session view and increments revision once per call', async () => {
    const r = await store.ingest(
      [
        claude('s1', cl('SessionStart'), { env: { herdr_pane_id: 'wS:p1' }, hostname: 'kvm16188' }),
        claude('s1', cl('UserPromptSubmit'), { ts: T0 + 1000 }),
        claude('s1', cl('PreToolUse.Bash'), { ts: T0 + 2000 }),
      ],
      'kvm',
    );
    expect(r).toEqual({ accepted: 3, ignored: 0, revision: 1 });
    const st = await store.state(OPTS);
    expect(st?.revision).toBe(1);
    expect(st?.sessions).toHaveLength(1);
    expect(st?.sessions[0]).toEqual({
      key: 'kvm/claude/s1',
      host: 'kvm',
      agent: 'claude',
      sessionId: 's1',
      cwd: '/home/user/proj',
      project: 'proj',
      title: "Do these steps: 1) run the shell command 'echo hi' with Bash. 2) Read the file hello.txt. 3) Use the Agent tool to spaw…",
      model: 'claude-haiku-5-5',
      state: 'working',
      stateKind: null,
      stateMsg: null,
      // client ts is ahead of the server clock (T0): times clamp to receivedAt
      stateSince: T0,
      lastEventAt: T0,
      startedAt: T0,
      endedAt: null,
      lastMessage: null,
      subagents: [],
      herdrPaneId: 'wS:p1',
      herdrTabId: null,
      herdrWorkspaceId: null,
      hostname: 'kvm16188',
      delayed: false,
      progress: [{ ts: T0, text: 'Bash: echo hi', agentType: null }],
    });
    const r2 = await store.ingest([claude('s1', cl('Stop'), { ts: T0 + 3000 })], 'kvm');
    expect(r2.revision).toBe(2);
  });

  it('dedupes by envelope id (within and across calls)', async () => {
    const e = claude('s1', cl('UserPromptSubmit'));
    expect(await store.ingest([e, e], 'kvm')).toEqual({ accepted: 1, ignored: 1, revision: 1 });
    expect(await store.ingest([e], 'kvm')).toEqual({ accepted: 0, ignored: 1, revision: 1 });
    expect(await count('events')).toBe(1);
  });

  it('empty or no-op ingests keep the revision', async () => {
    expect(await store.ingest([], 'kvm')).toEqual({ accepted: 0, ignored: 0, revision: 0 });
    const r = await store.ingest([claude('s1', { ...cl('Stop'), hook_event_name: 'PermissionDenied' })], 'kvm');
    expect(r).toEqual({ accepted: 1, ignored: 0, revision: 0 });
    expect(await count('events')).toBe(1);
    expect(await count('sessions')).toBe(0);
  });

  it('retains only deduplication metadata, not sensitive payload input', async () => {
    clock = T0 + 500;
    const e = claude('s1', {
      ...cl('Stop'),
      prompt: 'private prompt contents',
      tool_input: { file_path: '/private.txt', content: 'private Write contents' },
      custom_instructions: 'private custom instructions',
    });
    await store.ingest([e], 'kvm');
    const { rows } = await driver.exec(`SELECT * FROM events`);
    expect(rows).toEqual([
      { id: e.id, session_key: 'kvm/claude/s1', ts: T0, received_at: T0 + 500, type: 'Stop' },
    ]);
    const columns = (await driver.exec(`PRAGMA table_info(events)`)).rows.map((row) => row.name);
    expect(columns).toEqual(['id', 'session_key', 'ts', 'received_at', 'type']);
    expect(JSON.stringify(rows)).not.toContain('private');
    expect(await store.ingest([e], 'kvm')).toEqual({ accepted: 0, ignored: 1, revision: 1 });
  });

  it('since === revision -> null (304); otherwise a snapshot', async () => {
    await store.ingest([claude('s1', cl('UserPromptSubmit'))], 'kvm');
    expect(await store.state({ ...OPTS, since: 1 })).toBeNull();
    expect(await store.state({ ...OPTS, since: 0 })).not.toBeNull();
    expect(await store.state({ ...OPTS, since: 7 })).not.toBeNull();
    expect(await store.state(OPTS)).not.toBeNull();
  });

  it('separates sessions by host and agent, sorted by lastEventAt desc', async () => {
    await store.ingest([claude('s1', cl('UserPromptSubmit'), { ts: T0 - 3000 })], 'a');
    await store.ingest([claude('s1', cl('UserPromptSubmit'), { ts: T0 - 1000 })], 'b');
    await store.ingest(
      [envelope('omp', { ...fixture('omp', 'prompt'), sessionId: 's1' }, { ts: T0 - 2000 })],
      'a',
    );
    const st = await store.state(OPTS);
    expect(st?.sessions.map((s) => s.key)).toEqual(['b/claude/s1', 'a/omp/s1', 'a/claude/s1']);
  });

  it('filters ended sessions by endedWithinMs', async () => {
    await store.ingest([claude('live', cl('UserPromptSubmit'))], 'kvm');
    await store.ingest([claude('old', cl('SessionEnd'), { ts: T0 - 2 * HOUR_MS })], 'kvm');
    await store.ingest([claude('recent', cl('SessionEnd'), { ts: T0 - 10 * 60_000 })], 'kvm');
    const oneHour = await store.state(OPTS);
    expect(oneHour?.sessions.map((s) => s.sessionId).sort()).toEqual(['live', 'recent']);
    const day = await store.state({ ...OPTS, endedWithinMs: 24 * HOUR_MS });
    expect(day?.sessions.map((s) => s.sessionId).sort()).toEqual(['live', 'old', 'recent']);
    expect(day?.sessions.find((s) => s.sessionId === 'old')?.endedAt).toBe(T0 - 2 * HOUR_MS);
  });

  it('hides non-ended sessions silent for more than SILENT_HIDE_MS; a new event shows them again', async () => {
    await store.ingest([claude('busy', cl('UserPromptSubmit'))], 'kvm');
    await store.ingest([claude('done', cl('Stop'))], 'kvm');
    const ids = async (o: StateOptions = OPTS) => (await store.state(o))?.sessions.map((s) => s.sessionId).sort();
    clock = T0 + SILENT_HIDE_MS - 1; // kept while last_event_at > now - 24h
    expect(await ids()).toEqual(['busy', 'done']);
    clock = T0 + SILENT_HIDE_MS;
    // An ended session inside its window is unaffected by the silent rule.
    await store.ingest([claude('gone', cl('SessionEnd'), { ts: clock - 10 * 60_000 })], 'kvm');
    expect(await ids()).toEqual(['gone']);
    // Rows are kept (no auto-end) and the option can widen the cutoff.
    expect(await count('sessions')).toBe(3);
    expect(await ids({ ...OPTS, silentWithinMs: Number.MAX_SAFE_INTEGER })).toEqual(['busy', 'done', 'gone']);
    const busy = (await store.session('kvm/claude/busy'))!;
    expect(busy.state).toBe('working');
    // The next event makes it visible again.
    await store.ingest([claude('busy', cl('Stop'), { ts: clock })], 'kvm');
    expect(await ids()).toEqual(['busy', 'gone']);
  });

  it(`keeps the newest ${PROGRESS_KEEP} progress lines; state returns progressLimit, session returns all`, async () => {
    const batch = Array.from({ length: 15 }, (_, i) =>
      claude('s1', { ...cl('PreToolUse.Bash'), tool_input: { command: `step ${i}` } }, { ts: T0 - 60_000 + i * 1000 }),
    );
    await store.ingest(batch.slice(0, 7), 'kvm');
    await store.ingest(batch.slice(7), 'kvm');
    expect(await count('progress')).toBe(PROGRESS_KEEP);
    const st = await store.state(OPTS);
    expect(st?.sessions[0]?.progress.map((p) => p.text)).toEqual([
      'Bash: step 14',
      'Bash: step 13',
      'Bash: step 12',
      'Bash: step 11',
    ]);
    const full = await store.session('kvm/claude/s1');
    expect(full?.progress).toHaveLength(PROGRESS_KEEP);
    expect(full?.progress[0]?.text).toBe('Bash: step 14');
    expect(full?.progress[PROGRESS_KEEP - 1]?.text).toBe('Bash: step 5');
    const none = await store.state({ ...OPTS, progressLimit: 0 });
    expect(none?.sessions[0]?.progress).toEqual([]);
  });

  it('session(key) returns subagents and full fields; null for unknown', async () => {
    clock = T0 + 1000;
    await store.ingest(
      [
        claude('s1', cl('UserPromptSubmit')),
        claude('s1', cl('SubagentStart'), { ts: T0 + 1 }),
        claude('s1', cl('PreToolUse.subagent'), { ts: T0 + 2 }),
        claude('s1', cl('PermissionRequest'), { ts: T0 + 3 }),
      ],
      'kvm',
    );
    const v = await store.session('kvm/claude/s1');
    expect(v).toMatchObject({
      state: 'blocked',
      stateKind: 'permission',
      stateMsg: 'Bash: touch perm-test.txt',
      subagents: [{ id: 'a986ba181051e8e8a', type: 'Explore', since: T0 + 1 }],
      progress: [{ ts: T0 + 2, text: '[Explore] Read: hello.txt', agentType: 'Explore' }],
    });
    expect(await store.session('kvm/claude/nope')).toBeNull();
  });

  it('a permission prompt inside a subagent clears when that subagent proceeds', async () => {
    clock = T0 + 60_000;
    const sub = { agent_id: 'A1', agent_type: 'Explore' };
    const bash = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    await store.ingest(
      [
        claude('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
        claude('s1', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} }, { ts: T0 + 1 }),
        claude('s1', { hook_event_name: 'SubagentStart', ...sub }, { ts: T0 + 2 }),
        claude('s1', { hook_event_name: 'PermissionRequest', ...sub, ...bash }, { ts: T0 + 3 }),
      ],
      'kvm',
    );
    expect(await store.session('kvm/claude/s1')).toMatchObject({ state: 'blocked', stateKind: 'permission', stateMsg: 'Bash: ls' });
    // generic notification ~6 s later keeps the specific reason
    await store.ingest(
      [claude('s1', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }, { ts: T0 + 6000 })],
      'kvm',
    );
    expect(await store.session('kvm/claude/s1')).toMatchObject({ state: 'blocked', stateMsg: 'Bash: ls' });
    await store.ingest([claude('s1', { hook_event_name: 'PostToolUse', ...sub, ...bash }, { ts: T0 + 7000 })], 'kvm');
    expect(await store.session('kvm/claude/s1')).toMatchObject({ state: 'working', stateKind: null, stateMsg: null });
  });

  it.each([1, 2])('migrates schema v%i to metadata-only events without losing state or deduplication', async (version) => {
    const legacy = SCHEMA_STATEMENTS.map((sql) => {
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS events (')) {
        return `CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          session_key TEXT,
          ts INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          type TEXT NOT NULL,
          raw_json TEXT NOT NULL
        )`;
      }
      return version === 1
        ? sql.replace(/,\s*last_ts INTEGER NOT NULL DEFAULT 0,\s*state_agent TEXT/, '')
        : sql;
    });
    await driver.exec(`DROP TABLE sessions`);
    await driver.exec(`DROP TABLE events`);
    for (const sql of legacy) await driver.exec(sql);
    await driver.exec(`UPDATE meta SET v = ? WHERE k = 'schema_version'`, [String(version)]);
    await driver.exec(`UPDATE meta SET v = '7' WHERE k = 'revision'`);
    await driver.exec(
      `INSERT INTO sessions (key, host, agent, session_id, state, state_since, last_event_at, started_at)
       VALUES ('kvm/claude/s1', 'kvm', 'claude', 's1', 'working', ?, ?, ?)`,
      [T0, T0, T0],
    );
    if (version === 2) {
      await driver.exec(`UPDATE sessions SET last_ts = ?, state_agent = 'legacy-agent'`, [T0]);
    }
    await driver.exec(
      `INSERT INTO progress (session_key, ts, text, agent_type) VALUES ('kvm/claude/s1', ?, 'Bash: preserved', NULL)`,
      [T0],
    );
    const e = claude('s1', {
      ...cl('PreToolUse.Bash'),
      custom_instructions: 'legacy private instructions',
    }, { id: `legacy-v${version}` });
    await driver.exec(
      `INSERT INTO events (id, session_key, ts, received_at, type, raw_json) VALUES (?, 'kvm/claude/s1', ?, ?, 'PreToolUse', ?)`,
      [e.id, T0, T0, JSON.stringify(e)],
    );
    const sessionsBefore = (await driver.exec(`SELECT * FROM sessions`)).rows;
    const progressBefore = (await driver.exec(`SELECT * FROM progress`)).rows;

    await store.init();
    await store.init(); // the completed upgrade is idempotent
    const { rows } = await driver.exec(`SELECT v FROM meta WHERE k = 'schema_version'`);
    expect(rows[0]?.v).toBe(String(SCHEMA_VERSION));
    expect((await driver.exec(`SELECT * FROM sessions`)).rows).toMatchObject(sessionsBefore);
    expect((await driver.exec(`SELECT * FROM progress`)).rows).toEqual(progressBefore);
    expect((await driver.exec(`SELECT * FROM events`)).rows).toEqual([
      { id: e.id, session_key: 'kvm/claude/s1', ts: T0, received_at: T0, type: 'PreToolUse' },
    ]);
    expect((await driver.exec(`PRAGMA table_info(events)`)).rows.map((row) => row.name))
      .toEqual(['id', 'session_key', 'ts', 'received_at', 'type']);
    const preserved = await store.session('kvm/claude/s1');
    expect(preserved).toMatchObject({
      state: 'working',
      progress: [{ ts: T0, text: 'Bash: preserved', agentType: null }],
    });
    expect(await store.ingest([e], 'kvm')).toEqual({ accepted: 0, ignored: 1, revision: 7 });
    expect(await store.session('kvm/claude/s1')).toEqual(preserved);
    clock = T0 + 10_000;
    expect(await store.ingest([claude('s1', cl('PermissionRequest'), { ts: T0 + 5000 })], 'kvm'))
      .toEqual({ accepted: 1, ignored: 0, revision: 8 });
    expect(await store.session('kvm/claude/s1')).toMatchObject({ state: 'blocked', stateKind: 'permission' });
  });

  it('marks delayed deliveries', async () => {
    clock = T0 + 5 * 60_000;
    await store.ingest([claude('s1', cl('UserPromptSubmit'))], 'kvm');
    expect((await store.session('kvm/claude/s1'))?.delayed).toBe(true);
  });

  it('purge removes old events and sessions ended > 24h ago with their rows', async () => {
    await store.ingest([claude('gone', cl('PreToolUse.Bash'), { ts: T0 - 3 * DAY_MS })], 'kvm');
    await store.ingest([claude('gone', cl('SessionEnd'), { ts: T0 - 2 * DAY_MS })], 'kvm');
    await store.ingest([claude('keep', cl('PreToolUse.Bash'), { ts: T0 - 8 * DAY_MS })], 'kvm');
    await store.ingest([claude('fresh', cl('SessionEnd'), { ts: T0 - 1000 })], 'kvm');
    // received_at of every event is T0 (clock); move the clock forward past retention
    const now = T0 + EVENTS_RETENTION_MS + 1;
    await store.ingest([claude('keep', cl('Stop'), { ts: now - 1000 })], 'kvm'); // received at T0 too
    await store.purge(now);
    expect(await count('events')).toBe(0);
    const keys = (await driver.exec(`SELECT key FROM sessions ORDER BY key`)).rows.map((r) => r.key);
    // 'fresh' ended at T0-1000 which is now > 24h ago too; only the live session stays
    expect(keys).toEqual(['kvm/claude/keep']);
    expect((await driver.exec(`SELECT DISTINCT session_key FROM progress`)).rows).toEqual([
      { session_key: 'kvm/claude/keep' },
    ]);
  });

  it('purge keeps recent events and sessions ended within 24h', async () => {
    await store.ingest([claude('e1', cl('SessionEnd'), { ts: T0 })], 'kvm');
    await store.purge(T0 + ENDED_RETENTION_MS - 1);
    expect(await count('sessions')).toBe(1);
    expect(await count('events')).toBe(1);
    await store.purge(T0 + ENDED_RETENTION_MS + 1);
    expect(await count('sessions')).toBe(0);
    expect(await count('events')).toBe(0);
  });

  it(`runs purge inside ingest every ${PURGE_EVERY_REVISIONS} revisions`, async () => {
    await store.ingest([claude('dead', cl('SessionEnd'), { ts: T0 - 2 * DAY_MS })], 'kvm');
    expect(await count('sessions')).toBe(1);
    await driver.exec(`UPDATE meta SET v = ? WHERE k = 'revision'`, [String(PURGE_EVERY_REVISIONS - 2)]);
    const r1 = await store.ingest([claude('s1', cl('UserPromptSubmit'))], 'kvm');
    expect(r1.revision).toBe(PURGE_EVERY_REVISIONS - 1);
    expect(await count('sessions')).toBe(2);
    const r2 = await store.ingest([claude('s1', cl('PreToolUse.Bash'))], 'kvm');
    expect(r2.revision).toBe(PURGE_EVERY_REVISIONS);
    expect((await driver.exec(`SELECT key FROM sessions`)).rows).toEqual([{ key: 'kvm/claude/s1' }]);
  });

  it('a failing ingest rolls back and the store stays usable', async () => {
    const e = claude('s1', cl('UserPromptSubmit'));
    // Break the session upsert once to force a mid-transaction failure.
    const orig = driver.writeTx.bind(driver);
    let calls = 0;
    driver.writeTx = (fn) =>
      orig(async (exec) =>
        fn(async (sql, params) => {
          if (sql.startsWith('INSERT OR REPLACE INTO sessions') && calls++ === 0) throw new Error('disk full');
          return exec(sql, params);
        }),
      );
    await expect(store.ingest([e], 'kvm')).rejects.toThrow('disk full');
    expect(await count('events')).toBe(0);
    expect(await store.ingest([e], 'kvm')).toEqual({ accepted: 1, ignored: 0, revision: 1 });
  });

  it('concurrent ingest (Promise.all of 10 batches) loses nothing', async () => {
    const batches = Array.from({ length: 10 }, (_, b) =>
      Array.from({ length: 10 }, (_, i) =>
        claude(`s${b % 3}`, { ...cl('PreToolUse.Bash'), tool_input: { command: `b${b} i${i}` } }, { ts: T0 + b * 10 + i }),
      ),
    );
    const results = await Promise.all([
      ...batches.map((batch) => store.ingest(batch, 'kvm')),
      store.state(OPTS),
      store.ingest(batches[0]!, 'kvm'), // all duplicates
    ]);
    const ingests = results.filter((r): r is { accepted: number; ignored: number; revision: number } => r !== null && 'accepted' in r);
    expect(ingests.reduce((a, r) => a + r.accepted, 0)).toBe(100);
    expect(ingests.reduce((a, r) => a + r.ignored, 0)).toBe(10);
    // each changing call bumps exactly once; revisions are distinct and dense
    const revs = ingests.filter((r) => r.accepted > 0).map((r) => r.revision).sort((a, b) => a - b);
    expect(revs).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(await count('events')).toBe(100);
    const st = await store.state(OPTS);
    expect(st?.revision).toBe(10);
    expect(st?.sessions).toHaveLength(3);
    for (const s of st!.sessions) {
      expect(s.state).toBe('working');
      expect(s.progress).toHaveLength(PROGRESS_CARD);
    }
    expect(await count('progress')).toBe(3 * PROGRESS_KEEP);
  });

  it('full lifecycle from claude fixtures', async () => {
    clock = T0 + 1000;
    const seq = [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse.Bash',
      'SubagentStart',
      'PreToolUse.subagent',
      'SubagentStop',
      'PreToolUse.AskUserQuestion',
      // real order: the question is followed by a "permission" for it
      'PermissionRequest.AskUserQuestion',
      'Notification.permission_prompt',
      // stray SubagentStop for an unknown agent, agent_type ""
      'SubagentStop.no_start',
    ];
    await store.ingest(seq.map((n, i) => claude('s1', cl(n), { ts: T0 + i })), 'kvm');
    let v = await store.session('kvm/claude/s1');
    expect(v).toMatchObject({ state: 'blocked', stateKind: 'question', stateMsg: 'Which color?', subagents: [] });
    await store.ingest([claude('s1', cl('PostToolUse.AskUserQuestion'), { ts: T0 + 10 })], 'kvm');
    expect((await store.session('kvm/claude/s1'))?.state).toBe('working');
    await store.ingest([claude('s1', cl('Stop'), { ts: T0 + 20 })], 'kvm');
    v = await store.session('kvm/claude/s1');
    expect(v).toMatchObject({ state: 'done', lastMessage: 'done' });
    await store.ingest([claude('s1', cl('SessionEnd'), { ts: T0 + 30 })], 'kvm');
    v = await store.session('kvm/claude/s1');
    expect(v).toMatchObject({ state: 'ended', endedAt: T0 + 30 });
  });
  const codex = (sessionId: string, payload: Record<string, unknown>, over: Partial<Envelope> = {}) =>
    envelope('codex', { ...payload, session_id: sessionId }, { ts: T0, ...over });
  const cx = (name: string) => fixture('codex', name);

  it('codex request_user_input_async: open until the reply prompt, which keeps the title', async () => {
    clock = T0 + 1000;
    const seq = [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse.request_user_input_async',
      'PostToolUse.request_user_input_async',
      'PreToolUse.clocksleep',
    ];
    await store.ingest(seq.map((n, i) => codex('x1', cx(n), { ts: T0 + i })), 'kvm');
    let v = await store.session('kvm/codex/x1');
    expect(v).toMatchObject({ state: 'blocked', stateKind: 'question', stateMsg: 'Which color?' });
    // clocksleep finishing (PostToolUse of an ordinary tool) does not answer it
    await store.ingest([codex('x1', { ...cx('PostToolUse.Bash'), tool_name: 'clocksleep' }, { ts: T0 + 10 })], 'kvm');
    expect((await store.session('kvm/codex/x1'))?.state).toBe('blocked');
    const title = v?.title;
    await store.ingest([codex('x1', cx('UserPromptSubmit.question_reply'), { ts: T0 + 20 })], 'kvm');
    v = await store.session('kvm/codex/x1');
    expect(v).toMatchObject({ state: 'working', stateKind: null, title });
    expect(title).toMatch(/^Steps: 1\) run the shell command/);
  });

  it('codex permission: ordinary PostToolUse unblocks, subagent prefix uses agent_id', async () => {
    clock = T0 + 1000;
    const seq = ['UserPromptSubmit', 'SubagentStart', 'PreToolUse.subagent', 'PermissionRequest'];
    await store.ingest(seq.map((n, i) => codex('x1', cx(n), { ts: T0 + i })), 'kvm');
    let v = await store.session('kvm/codex/x1');
    expect(v).toMatchObject({
      state: 'blocked',
      stateKind: 'permission',
      subagents: [{ id: '01a186f2-affe-7b03-9c7e-e0e0eb4b9642', type: '01a186f2' }],
      progress: [{ text: '[01a186f2] Bash: cat hello.txt', agentType: '01a186f2' }],
    });
    await store.ingest([codex('x1', cx('PostToolUse.Bash'), { ts: T0 + 10 })], 'kvm');
    v = await store.session('kvm/codex/x1');
    expect(v?.state).toBe('working');
  });

  it('codex: a new session started/cleared in the same pane ends the older one', async () => {
    clock = T0 + 10_000;
    const pane = { herdr_pane_id: 'wS:p1' };
    await store.ingest(
      [
        codex('old', cx('SessionStart'), { env: pane }),
        codex('old', cx('UserPromptSubmit'), { ts: T0 + 1 }),
        codex('other-pane', cx('SessionStart'), { env: { herdr_pane_id: 'wS:p2' } }),
        codex('tmux-only', cx('SessionStart'), { env: { tmux_pane: '%3' } }),
      ],
      'kvm',
    );
    // claude in the same pane is never touched
    await store.ingest([claude('cl', cl('SessionStart'), { env: pane })], 'kvm');
    const r = await store.ingest([codex('new', cx('SessionStart.clear'), { ts: T0 + 100, env: pane })], 'kvm');
    expect(r.revision).toBe(3);
    const st = await store.state(OPTS);
    const byId = Object.fromEntries(st!.sessions.map((s) => [s.key, s]));
    expect(byId['kvm/codex/old']).toMatchObject({ state: 'ended', endedAt: T0 + 100 });
    expect(byId['kvm/codex/new']).toMatchObject({ state: 'idle', herdrPaneId: 'wS:p1' });
    expect(byId['kvm/codex/other-pane']?.state).toBe('idle');
    expect(byId['kvm/codex/tmux-only']?.state).toBe('idle');
    expect(byId['kvm/claude/cl']?.state).toBe('idle');

    // tmux pane fallback (no herdr id), within one batch; other hosts untouched
    await store.ingest([codex('tmux-other-host', cx('SessionStart'), { env: { tmux_pane: '%3' } })], 'other');
    await store.ingest(
      [
        codex('tmux-new', cx('SessionStart'), { ts: T0 + 200, env: { tmux_pane: '%3' } }),
        codex('tmux-new', cx('UserPromptSubmit'), { ts: T0 + 201, env: { tmux_pane: '%3' } }),
      ],
      'kvm',
    );
    expect((await store.session('kvm/codex/tmux-only'))?.state).toBe('ended');
    expect((await store.session('kvm/codex/tmux-new'))?.state).toBe('working');
    expect((await store.session('other/codex/tmux-other-host'))?.state).toBe('idle');

    // a later event from the replaced session reopens it (e.g. a nested codex exec ended it)
    await store.ingest([codex('old', cx('PreToolUse.Bash'), { ts: T0 + 300 })], 'kvm');
    expect((await store.session('kvm/codex/old'))?.state).toBe('working');
  });

  it('codex: a nested/parallel `codex exec` in the same pane does not end a busy session', async () => {
    clock = T0 + 10_000;
    const pane = { herdr_pane_id: 'wS:p1' };
    await store.ingest(
      [
        codex('parent', cx('SessionStart'), { env: pane }),
        codex('parent', cx('UserPromptSubmit'), { ts: T0 + 1, env: pane }),
        codex('parent', cx('PreToolUse.Bash'), { ts: T0 + 2, env: pane }),
      ],
      'kvm',
    );
    await store.ingest([codex('child', cx('SessionStart'), { ts: T0 + 3, env: pane })], 'kvm');
    expect(await store.session('kvm/codex/parent')).toMatchObject({ state: 'working' });
    // a blocked session is not replaced by a startup either
    await store.ingest([codex('parent', cx('PermissionRequest'), { ts: T0 + 4, env: pane })], 'kvm');
    await store.ingest([codex('child2', cx('SessionStart'), { ts: T0 + 5, env: pane })], 'kvm');
    expect((await store.session('kvm/codex/parent'))?.state).toBe('blocked');
    // the child, once done, is replaced by the next exec in that pane
    await store.ingest([codex('child', cx('Stop'), { ts: T0 + 6, env: pane })], 'kvm');
    await store.ingest([codex('child3', cx('SessionStart'), { ts: T0 + 7, env: pane })], 'kvm');
    expect((await store.session('kvm/codex/child'))?.state).toBe('ended');
    expect((await store.session('kvm/codex/parent'))?.state).toBe('blocked');
    // a busy session that has been silent for STALE_MS (killed mid-turn) is replaced
    clock = T0 + 10_000 + STALE_MS + 1;
    await store.ingest([codex('later', cx('SessionStart'), { ts: clock, env: pane })], 'kvm');
    expect((await store.session('kvm/codex/parent'))?.state).toBe('ended');
  });

  it('codex: resume/compact sources and a missing pane do not end anything', async () => {
    clock = T0 + 10_000;
    const pane = { herdr_pane_id: 'wS:p1' };
    await store.ingest([codex('old', cx('SessionStart'), { env: pane })], 'kvm');
    await store.ingest([codex('r', { ...cx('SessionStart'), source: 'resume' }, { ts: T0 + 1, env: pane })], 'kvm');
    await store.ingest([codex('n', cx('SessionStart'), { ts: T0 + 2 })], 'kvm');
    expect((await store.session('kvm/codex/old'))?.state).toBe('idle');
  });
});
