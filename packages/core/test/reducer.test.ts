import { describe, expect, it } from 'vitest';
import {
  DELAYED_MS,
  LAST_MESSAGE_MAX,
  OUT_OF_ORDER_GRACE_MS,
  PROGRESS_LINE_MAX,
  STALE_MS,
  STATE_MSG_MAX,
  TITLE_MAX,
  applyEvent,
} from '../src/index.js';
import type { CanonicalEvent, ReduceMeta, SessionRow } from '../src/types.js';

const T0 = 1_761_721_000_000;
const sid = 's1';

function meta(ts: number, over: Partial<ReduceMeta> = {}): ReduceMeta {
  return { host: 'kvm', agent: 'claude', ts, receivedAt: ts, ...over };
}

/** Apply events in order, each 1s apart starting at T0; returns the final result. */
function run(events: CanonicalEvent[], start: SessionRow | null = null, t0 = T0) {
  let row = start;
  let res = null as ReturnType<typeof applyEvent> | null;
  events.forEach((ev, i) => {
    res = applyEvent(row, ev, meta(t0 + i * 1000));
    row = res.session;
  });
  return res!;
}

const ev = {
  start: (extra: object = {}): CanonicalEvent => ({ type: 'session_start', sessionId: sid, ...extra }),
  prompt: (text = 'hello'): CanonicalEvent => ({ type: 'prompt', sessionId: sid, text }),
  tool: (tool = 'Bash', summary = 'ls', agentType?: string): CanonicalEvent =>
    agentType
      ? { type: 'tool_start', sessionId: sid, tool, summary, agentType }
      : { type: 'tool_start', sessionId: sid, tool, summary },
  blocked: (kind: 'permission' | 'question' = 'permission', msg = 'Bash: rm'): CanonicalEvent => ({
    type: 'blocked',
    sessionId: sid,
    kind,
    msg,
  }),
  unblocked: (): CanonicalEvent => ({ type: 'unblocked', sessionId: sid }),
  done: (text = 'finished'): CanonicalEvent => ({ type: 'turn_done', sessionId: sid, text }),
  error: (text = 'boom'): CanonicalEvent => ({ type: 'error', sessionId: sid, text }),
  interrupt: (): CanonicalEvent => ({ type: 'interrupt', sessionId: sid }),
  idle: (): CanonicalEvent => ({ type: 'idle_hint', sessionId: sid }),
  subStart: (agentId: string, agentType: string): CanonicalEvent => ({
    type: 'subagent_start',
    sessionId: sid,
    agentId,
    agentType,
  }),
  subStop: (agentId: string, agentType: string): CanonicalEvent => ({
    type: 'subagent_stop',
    sessionId: sid,
    agentId,
    agentType,
  }),
  compact: (): CanonicalEvent => ({ type: 'compact', sessionId: sid }),
  progress: (text: string): CanonicalEvent => ({ type: 'progress', sessionId: sid, text }),
  end: (reason?: string): CanonicalEvent =>
    reason ? { type: 'session_end', sessionId: sid, reason } : { type: 'session_end', sessionId: sid },
};

describe('applyEvent', () => {
  it('session_start creates an idle session with metadata', () => {
    const r = applyEvent(
      null,
      { type: 'session_start', sessionId: sid, cwd: '/home/dev/work/proj/', model: 'opus' },
      meta(T0, { env: { herdr_pane_id: 'wS:p1', tmux_pane: '%3' }, hostname: 'kvm16188' }),
    );
    expect(r.changed).toBe(true);
    expect(r.progressLine).toBeUndefined();
    expect(r.session).toMatchObject({
      key: 'kvm/claude/s1',
      host: 'kvm',
      agent: 'claude',
      session_id: sid,
      cwd: '/home/dev/work/proj/',
      project: 'proj',
      model: 'opus',
      state: 'idle',
      state_kind: null,
      started_at: T0,
      state_since: T0,
      last_event_at: T0,
      ended_at: null,
      subagents_json: '{}',
      herdr_pane_id: 'wS:p1',
      herdr_tab_id: null,
      tmux_pane: '%3',
      hostname: 'kvm16188',
      delayed: 0,
    });
  });

  it('session_start on an existing non-ended session does not change state', () => {
    const working = run([ev.start(), ev.prompt()]).session;
    const r = applyEvent(working, ev.start(), meta(T0 + 5000));
    expect(r.session.state).toBe('working');
    expect(r.session.state_since).toBe(working.state_since);
  });

  it('session_start reopens an ended session as idle', () => {
    const ended = run([ev.start(), ev.subStart('a', 'Explore'), ev.end('exit')]).session;
    expect(ended.state).toBe('ended');
    expect(ended.ended_at).not.toBeNull();
    const r = applyEvent(ended, ev.start({ source: 'resume' }), meta(T0 + 10_000));
    expect(r.session).toMatchObject({ state: 'idle', ended_at: null, subagents_json: '{}', state_since: T0 + 10_000 });
  });

  it('an unknown session is created implicitly by any event', () => {
    const r = applyEvent(null, ev.tool(), meta(T0));
    expect(r.session).toMatchObject({ state: 'working', started_at: T0 });
    expect(r.progressLine).toEqual({ ts: T0, text: 'Bash: ls', agentType: null });
  });

  it('prompt -> working, title = first non-blank line clipped to TITLE_MAX', () => {
    const r = run([ev.start(), ev.prompt('\n  Fix the tests  \nsecond line')]);
    expect(r.session).toMatchObject({ state: 'working', title: 'Fix the tests' });
    const long = run([ev.prompt('y'.repeat(500))]).session.title!;
    expect(Array.from(long)).toHaveLength(TITLE_MAX);
    // A blank (redacted) prompt keeps the previous title.
    const kept = run([ev.prompt('first'), ev.prompt('')]).session;
    expect(kept.title).toBe('first');
  });

  it('tool_start -> working + progress line with [agentType] prefix, <= 160 chars', () => {
    const r = run([ev.start(), ev.tool('Grep', 'applyEvent', 'Explore')]);
    expect(r.session.state).toBe('working');
    expect(r.progressLine).toEqual({ ts: T0 + 1000, text: '[Explore] Grep: applyEvent', agentType: 'Explore' });
    const long = run([ev.tool('Bash', 'z'.repeat(400), 'Explore')]).progressLine!;
    expect(Array.from(long.text)).toHaveLength(PROGRESS_LINE_MAX);
    expect(run([ev.tool('Read', '')]).progressLine!.text).toBe('Read');
  });

  it('progress only appends a line', () => {
    const r = run([ev.start(), ev.done(), ev.progress('✗ Bash failed')]);
    expect(r.session.state).toBe('done');
    expect(r.progressLine?.text).toBe('✗ Bash failed');
  });

  it('blocked -> blocked(kind,msg); unblocked only from blocked -> working', () => {
    const b = run([ev.start(), ev.prompt(), ev.blocked('question', 'Which DB?')]);
    expect(b.session).toMatchObject({ state: 'blocked', state_kind: 'question', state_msg: 'Which DB?', state_since: T0 + 2000 });
    const u = applyEvent(b.session, ev.unblocked(), meta(T0 + 3000));
    expect(u.session).toMatchObject({ state: 'working', state_kind: null, state_msg: null, state_since: T0 + 3000 });
    const fromDone = run([ev.start(), ev.done(), ev.unblocked()]).session;
    expect(fromDone.state).toBe('done');
    const longMsg = run([ev.blocked('permission', 'm'.repeat(999))]).session.state_msg!;
    expect(Array.from(longMsg)).toHaveLength(STATE_MSG_MAX);
  });

  it('switching blocked kind updates state_since', () => {
    const r = run([ev.blocked('permission'), ev.blocked('question', 'q')]);
    expect(r.session).toMatchObject({ state_kind: 'question', state_since: T0 + 1000 });
  });

  it("a subagent's tool_start does not clear the main agent's blocked prompt", () => {
    const b = run([ev.prompt(), ev.blocked('permission', 'Bash: rm')]).session;
    const r = applyEvent(b, ev.tool('Grep', 'x', 'Explore'), meta(T0 + 5000));
    expect(r.session.state).toBe('blocked');
    expect(r.progressLine?.text).toBe('[Explore] Grep: x');
    const main = applyEvent(b, ev.tool('Bash', 'rm'), meta(T0 + 5000));
    expect(main.session.state).toBe('working');
  });

  it('a pending question survives a permission notification and main tool calls', () => {
    const q = run([ev.prompt(), ev.blocked('question', 'Which color?')]).session;
    // Claude: Notification(permission_prompt) right after AskUserQuestion
    const note: CanonicalEvent = {
      type: 'blocked',
      sessionId: sid,
      kind: 'permission',
      msg: 'Claude needs your permission',
      notification: true,
    };
    const p = applyEvent(q, note, meta(T0 + 5000));
    expect(p.session).toMatchObject({ state: 'blocked', state_kind: 'question', state_msg: 'Which color?' });
    expect(p.changed).toBe(true); // last_event_at moved
    // Codex keeps running tools while request_user_input_async is open
    const t = applyEvent(q, ev.tool('clocksleep', ''), meta(T0 + 5000));
    expect(t.session).toMatchObject({ state: 'blocked', state_kind: 'question' });
    expect(t.progressLine?.text).toBe('clocksleep');
    // a permission prompt is still replaced by a question
    const perm = run([ev.prompt(), ev.blocked('permission')]).session;
    expect(applyEvent(perm, ev.blocked('question', 'q'), meta(T0 + 5000)).session.state_kind).toBe('question');
  });

  it('a real permission request during an open (Codex async) question replaces it', () => {
    const q = run([ev.prompt(), ev.blocked('question', 'Which color?')]).session;
    const p = applyEvent(q, ev.blocked('permission', 'exec_command: rm -rf build'), meta(T0 + 5000));
    expect(p.session).toMatchObject({ state: 'blocked', state_kind: 'permission', state_msg: 'exec_command: rm -rf build' });
  });

  it('a generic notification does not overwrite the specific permission reason', () => {
    const b = run([ev.prompt(), ev.blocked('permission', 'Bash: rm -rf build')]).session;
    const note: CanonicalEvent = {
      type: 'blocked',
      sessionId: sid,
      kind: 'permission',
      msg: 'Claude needs your permission',
      notification: true,
    };
    const r = applyEvent(b, note, meta(T0 + 7000));
    expect(r.session).toMatchObject({ state: 'blocked', state_kind: 'permission', state_msg: 'Bash: rm -rf build' });
    expect(r.session.state_since).toBe(b.state_since);
    // ...but still reports a prompt when nothing is pending yet
    const w = run([ev.prompt()]).session;
    expect(applyEvent(w, note, meta(T0 + 7000)).session).toMatchObject({
      state: 'blocked',
      state_kind: 'permission',
      state_msg: 'Claude needs your permission',
    });
  });

  describe('permission prompts raised inside a subagent', () => {
    const subBlocked: CanonicalEvent = { type: 'blocked', sessionId: sid, agentId: 'A1', kind: 'permission', msg: 'Bash: ls' };
    const unblock = (agentId?: string): CanonicalEvent =>
      agentId
        ? { type: 'unblocked', sessionId: sid, agentId, kind: 'permission' }
        : { type: 'unblocked', sessionId: sid, kind: 'permission' };
    const subTool = (agentId: string): CanonicalEvent => ({
      type: 'tool_start',
      sessionId: sid,
      agentType: 'Explore',
      agentId,
      tool: 'Read',
      summary: 'f',
    });
    const blocked = () => run([ev.prompt(), ev.tool('Agent', 'x'), ev.subStart('A1', 'Explore'), subBlocked]).session;

    it("are cleared by that subagent's PostToolUse", () => {
      const b = blocked();
      expect(b).toMatchObject({ state: 'blocked', state_kind: 'permission', state_agent: 'A1' });
      const r = applyEvent(b, unblock('A1'), meta(T0 + 9000));
      expect(r.session).toMatchObject({ state: 'working', state_kind: null, state_agent: null });
    });

    it("are cleared by that subagent's next tool call (e.g. after a denial) or its stop", () => {
      expect(applyEvent(blocked(), subTool('A1'), meta(T0 + 9000)).session.state).toBe('working');
      expect(applyEvent(blocked(), ev.subStop('A1', 'Explore'), meta(T0 + 9000)).session.state).toBe('working');
    });

    it('are not cleared by another agent', () => {
      const b = blocked();
      expect(applyEvent(b, unblock('A2'), meta(T0 + 9000)).session.state).toBe('blocked');
      expect(applyEvent(b, unblock(), meta(T0 + 9000)).session.state).toBe('blocked');
      expect(applyEvent(b, subTool('A2'), meta(T0 + 9000)).session.state).toBe('blocked');
      expect(applyEvent(b, ev.subStop('A2', 'Plan'), meta(T0 + 9000)).session.state).toBe('blocked');
    });

    it("a subagent's PostToolUse does not clear the main agent's permission prompt", () => {
      const b = run([ev.prompt(), ev.blocked('permission', 'Bash: rm')]).session;
      expect(b.state_agent).toBeNull();
      expect(applyEvent(b, unblock('A1'), meta(T0 + 9000)).session.state).toBe('blocked');
      expect(applyEvent(b, unblock(), meta(T0 + 9000)).session.state).toBe('working');
    });
  });

  it('unblocked with a kind only clears that kind', () => {
    const permOnly: CanonicalEvent = { type: 'unblocked', sessionId: sid, kind: 'permission' };
    const q = run([ev.prompt(), ev.blocked('question', 'Which color?')]).session;
    expect(applyEvent(q, permOnly, meta(T0 + 5000)).session.state).toBe('blocked');
    expect(applyEvent(q, ev.unblocked(), meta(T0 + 5000)).session.state).toBe('working');
    const p = run([ev.prompt(), ev.blocked('permission')]).session;
    expect(applyEvent(p, permOnly, meta(T0 + 5000)).session.state).toBe('working');
    // a blank (reply/redacted) prompt answers anything and keeps the title
    const r = applyEvent(run([ev.prompt('Pick a color'), ev.blocked('question', 'q')]).session, ev.prompt(''), meta(T0 + 5000));
    expect(r.session).toMatchObject({ state: 'working', title: 'Pick a color' });
  });

  it('subagent_stop for an unknown agent id changes nothing', () => {
    const s = run([ev.prompt(), ev.subStart('a', 'Explore')]).session;
    const r = applyEvent(s, ev.subStop('zzz', 'subagent'), meta(T0 + 1000));
    expect(r.session.subagents_json).toBe(s.subagents_json);
    expect(r.session.state).toBe('working');
  });

  it('stores env.tmux_pane', () => {
    const r = applyEvent(null, ev.start(), meta(T0, { env: { tmux_pane: '%7' } }));
    expect(r.session.tmux_pane).toBe('%7');
  });

  it('turn_done -> done with last_message clipped to 300', () => {
    const r = run([ev.prompt(), ev.done('All good.\nDetails.')]);
    expect(r.session).toMatchObject({ state: 'done', last_message: 'All good.\nDetails.' });
    const long = run([ev.done('w'.repeat(1000))]).session.last_message!;
    expect(Array.from(long)).toHaveLength(LAST_MESSAGE_MAX);
  });

  it('error -> error with state_msg and last_message', () => {
    const r = run([ev.prompt(), ev.error('API Error: 529')]);
    expect(r.session).toMatchObject({ state: 'error', state_msg: 'API Error: 529', last_message: 'API Error: 529' });
  });

  it('interrupt -> idle and clears blocked', () => {
    const r = run([ev.prompt(), ev.blocked('question', 'q'), ev.interrupt()]);
    expect(r.session).toMatchObject({ state: 'idle', state_kind: null, state_msg: null });
  });

  it('idle_hint: working -> done only', () => {
    expect(run([ev.prompt(), ev.idle()]).session.state).toBe('done');
    expect(run([ev.prompt(), ev.blocked(), ev.idle()]).session.state).toBe('blocked');
    expect(run([ev.start(), ev.idle()]).session.state).toBe('idle');
  });

  it('subagent_start/stop maintain subagents_json; session_end clears it', () => {
    const r1 = run([ev.prompt(), ev.subStart('a1', 'Explore'), ev.subStart('a2', 'Plan')]);
    expect(JSON.parse(r1.session.subagents_json)).toEqual({
      a1: { type: 'Explore', since: T0 + 1000 },
      a2: { type: 'Plan', since: T0 + 2000 },
    });
    expect(r1.progressLine).toBeUndefined();
    expect(r1.session.state).toBe('working');
    const r2 = applyEvent(r1.session, ev.subStop('a1', 'Explore'), meta(T0 + 3000));
    expect(JSON.parse(r2.session.subagents_json)).toEqual({ a2: { type: 'Plan', since: T0 + 2000 } });
    const r3 = applyEvent(r2.session, ev.subStop('zz', 'X'), meta(T0 + 4000));
    expect(r3.session.subagents_json).toBe(r2.session.subagents_json);
    const r4 = applyEvent(r3.session, ev.end(), meta(T0 + 5000));
    expect(r4.session.subagents_json).toBe('{}');
  });

  it('compact appends "compacting context"', () => {
    const r = run([ev.prompt(), ev.compact()]);
    expect(r.progressLine?.text).toBe('compacting context');
    expect(r.session.state).toBe('working');
  });

  it('session_end -> ended with ended_at; a later prompt clears ended_at', () => {
    const r = run([ev.prompt(), ev.end('exit')]);
    expect(r.session).toMatchObject({ state: 'ended', ended_at: T0 + 1000 });
    const again = applyEvent(r.session, ev.prompt('again'), meta(T0 + 9000));
    expect(again.session).toMatchObject({ state: 'working', ended_at: null });
  });

  describe('out-of-order protection', () => {
    it('events older than last_event_at - 5s only add progress', () => {
      const cur = run([ev.prompt(), ev.blocked('question', 'q')]).session; // last_event_at = T0+1000
      const oldTs = cur.last_event_at - OUT_OF_ORDER_GRACE_MS - 1;
      const late = applyEvent(cur, ev.tool('Bash', 'old'), meta(oldTs, { receivedAt: T0 + 20_000 }));
      expect(late.session).toEqual(cur);
      expect(late.progressLine).toEqual({ ts: oldTs, text: 'Bash: old', agentType: null });
      expect(late.changed).toBe(true);
      const lateDone = applyEvent(cur, ev.done(), meta(oldTs));
      expect(lateDone.session).toEqual(cur);
      expect(lateDone.changed).toBe(false);
    });

    it('events within the grace window still apply; last_event_at never goes back', () => {
      const cur = run([ev.prompt()], null, T0 + 10_000).session;
      const r = applyEvent(cur, ev.done(), meta(T0 + 10_000 - OUT_OF_ORDER_GRACE_MS));
      expect(r.session.state).toBe('done');
      expect(r.session.last_event_at).toBe(T0 + 10_000);
    });
  });

  it('out-of-order guard uses the client clock even when the host clock is ahead', () => {
    const skew = 60_000;
    const m = (t: number, recv = t) => meta(t + skew, { receivedAt: recv });
    let row = applyEvent(null, ev.prompt(), m(T0)).session;
    row = applyEvent(row, ev.done(), m(T0 + 40_000)).session;
    expect(row.state).toBe('done');
    // a PreToolUse generated 30 s before Stop arrives late
    const late = applyEvent(row, ev.tool('Bash', 'old'), m(T0 + 10_000, T0 + 41_000));
    expect(late.session.state).toBe('done');
    expect(late.progressLine?.text).toBe('Bash: old');
    // progress lines carry the clamped (server-bounded) time, not the future ts
    expect(late.progressLine?.ts).toBe(T0 + 41_000);
  });

  it('a host clock stepping back stops the guard once the session went quiet for STALE_MS', () => {
    const row = run([ev.prompt(), ev.done()], null, T0 + 3_600_000).session; // ahead by 1h
    const now = T0 + 1000;
    // fresh event right after the clock was corrected: still treated as late
    const soon = applyEvent(row, ev.prompt('x'), meta(now, { receivedAt: now }));
    expect(soon.session.state).toBe('done');
    // after STALE_MS of silence, a fresh event is applied and becomes the reference
    const later = T0 + 3_600_000 + 1000 + STALE_MS + 1; // receivedAt in server time
    const r = applyEvent(row, ev.prompt('x'), meta(later - 5000, { receivedAt: later }));
    expect(r.session).toMatchObject({ state: 'working', last_ts: later - 5000 });
    // ...but a genuinely delayed event is still dropped
    const d = applyEvent(row, ev.prompt('x'), meta(T0, { receivedAt: later }));
    expect(d.session.state).toBe('done');
  });

  it('last_event_at = min(ts, receivedAt) (client clock ahead of server)', () => {
    const r = applyEvent(null, ev.prompt(), meta(T0 + 30_000, { receivedAt: T0 }));
    expect(r.session.last_event_at).toBe(T0);
    expect(r.session.state_since).toBe(T0);
  });

  it(`delayed when receivedAt - ts > ${DELAYED_MS}ms, cleared by the next timely event`, () => {
    const d = applyEvent(null, ev.prompt(), meta(T0, { receivedAt: T0 + DELAYED_MS + 1 }));
    expect(d.session.delayed).toBe(1);
    const edge = applyEvent(null, ev.prompt(), meta(T0, { receivedAt: T0 + DELAYED_MS }));
    expect(edge.session.delayed).toBe(0);
    const next = applyEvent(d.session, ev.tool(), meta(T0 + DELAYED_MS + 2000, { receivedAt: T0 + DELAYED_MS + 2000 }));
    expect(next.session.delayed).toBe(0);
  });

  it('state_since only moves when the state changes', () => {
    const r = run([ev.prompt(), ev.tool(), ev.tool(), ev.tool()]);
    expect(r.session.state_since).toBe(T0);
    expect(r.session.last_event_at).toBe(T0 + 3000);
  });

  it('is pure: never mutates prev', () => {
    const prev = run([ev.prompt(), ev.subStart('a', 'X')]).session;
    const snapshot = structuredClone(prev);
    applyEvent(prev, ev.end(), meta(T0 + 10_000, { env: { herdr_pane_id: 'p' }, hostname: 'h' }));
    expect(prev).toEqual(snapshot);
  });

  it('changed is false for a no-op event', () => {
    const cur = run([ev.start()]).session;
    const r = applyEvent(cur, ev.unblocked(), meta(cur.last_event_at));
    expect(r.changed).toBe(false);
  });
});
