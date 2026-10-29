import { HOUR_MS, MINUTE_MS, STALE_MS } from '@jfm/core';
import type { SessionView } from '@jfm/core';
import { describe, expect, it } from 'vitest';
import {
  countGroups,
  endedWindowMs,
  groupSessions,
  hostsOf,
  isStale,
  sectionOf,
  SECTION_ORDER,
  withinEndedWindow,
} from '../src/group.ts';

const NOW = 1_800_000_000_000;

function s(id: string, over: Partial<SessionView> = {}): SessionView {
  const host = over.host ?? 'h1';
  return {
    key: `${host}/claude/${id}`,
    host,
    agent: 'claude',
    sessionId: id,
    cwd: null,
    project: null,
    title: null,
    model: null,
    state: 'idle',
    stateKind: null,
    stateMsg: null,
    stateSince: NOW - MINUTE_MS,
    lastEventAt: NOW - MINUTE_MS,
    startedAt: NOW - 60 * MINUTE_MS,
    endedAt: null,
    lastMessage: null,
    subagents: [],
    herdrPaneId: null,
    herdrTabId: null,
    herdrWorkspaceId: null,
    hostname: null,
    delayed: false,
    progress: [],
    ...over,
  };
}

const ids = (xs: SessionView[]) => xs.map((x) => x.sessionId);

describe('isStale', () => {
  it('only working/blocked, strictly more than STALE_MS', () => {
    expect(isStale({ state: 'working', lastEventAt: NOW - STALE_MS }, NOW)).toBe(false);
    expect(isStale({ state: 'working', lastEventAt: NOW - STALE_MS - 1 }, NOW)).toBe(true);
    expect(isStale({ state: 'blocked', lastEventAt: NOW - STALE_MS - 1 }, NOW)).toBe(true);
    for (const st of ['idle', 'done', 'error', 'ended'] as const) {
      expect(isStale({ state: st, lastEventAt: NOW - 10 * STALE_MS }, NOW)).toBe(false);
    }
  });
});

describe('sectionOf', () => {
  it('maps states to the four bands', () => {
    expect(sectionOf({ state: 'blocked' })).toBe('blocked');
    expect(sectionOf({ state: 'working' })).toBe('working');
    expect(sectionOf({ state: 'done' })).toBe('rest');
    expect(sectionOf({ state: 'idle' })).toBe('rest');
    expect(sectionOf({ state: 'error' })).toBe('rest');
    expect(sectionOf({ state: 'ended' })).toBe('ended');
    expect(SECTION_ORDER).toEqual(['blocked', 'working', 'rest', 'ended']);
  });
});

describe('groupSessions', () => {
  const list = [
    s('w-fresh', { state: 'working', lastEventAt: NOW - 5_000 }),
    s('w-old', { state: 'working', lastEventAt: NOW - 2 * MINUTE_MS }),
    s('w-stale-recent', { state: 'working', lastEventAt: NOW - STALE_MS - MINUTE_MS }),
    s('w-stale-oldest', { state: 'working', lastEventAt: NOW - 3 * STALE_MS }),
    s('b-question-new', { state: 'blocked', stateKind: 'question', stateSince: NOW - MINUTE_MS }),
    s('b-perm-long', { state: 'blocked', stateKind: 'permission', stateSince: NOW - 9 * MINUTE_MS, host: 'h2' }),
    s('done-new', { state: 'done', lastEventAt: NOW - MINUTE_MS }),
    s('idle-old', { state: 'idle', lastEventAt: NOW - 30 * MINUTE_MS }),
    s('err-old', { state: 'error', lastEventAt: NOW - 50 * MINUTE_MS, host: 'h2' }),
    s('end-a', { state: 'ended', endedAt: NOW - 40 * MINUTE_MS }),
    s('end-b', { state: 'ended', endedAt: NOW - 5 * MINUTE_MS, host: 'h2' }),
  ];

  it('orders each section by its rule', () => {
    const g = groupSessions(list, NOW);
    expect(ids(g.blocked)).toEqual(['b-perm-long', 'b-question-new']); // longest wait first, both kinds together
    expect(ids(g.working)).toEqual(['w-stale-recent', 'w-stale-oldest', 'w-fresh', 'w-old']); // stale first
    expect(ids(g.rest)).toEqual(['err-old', 'done-new', 'idle-old']); // errors first, then recency
    expect(ids(g.ended)).toEqual(['end-b', 'end-a']);
  });

  it('does not mutate the input and loses nothing', () => {
    const before = ids(list);
    const g = groupSessions(list, NOW);
    expect(ids(list)).toEqual(before);
    expect(g.blocked.length + g.working.length + g.rest.length + g.ended.length).toBe(list.length);
  });

  it('filters by host', () => {
    const g = groupSessions(list, NOW, 'h2');
    expect(ids(g.blocked)).toEqual(['b-perm-long']);
    expect(g.working).toEqual([]);
    expect(ids(g.rest)).toEqual(['err-old']);
    expect(ids(g.ended)).toEqual(['end-b']);
    expect(groupSessions(list, NOW, 'nope').blocked).toEqual([]);
  });

  it('breaks ties deterministically by key', () => {
    const tie = [s('z', { state: 'done' }), s('a', { state: 'done' })];
    expect(ids(groupSessions(tie, NOW).rest)).toEqual(['a', 'z']);
  });

  it('counts sections and stale (working + blocked); errors are not counted as done', () => {
    const extra = [...list, s('b-stale', { state: 'blocked', stateSince: NOW - 20 * MINUTE_MS, lastEventAt: NOW - 20 * MINUTE_MS })];
    const c = countGroups(groupSessions(extra, NOW), NOW);
    expect(c).toEqual({ blocked: 3, working: 4, stale: 3, rest: 2, error: 1, ended: 2 });
  });
});

describe('withinEndedWindow', () => {
  // Regression: 304 never re-runs the server's ended filter, so on a quiet farm
  // a session that ended at 22:00 was still listed at 08:00.
  const list = [
    s('live', { state: 'done', lastEventAt: NOW - 5 * HOUR_MS }),
    s('end-recent', { state: 'ended', endedAt: NOW - 30 * MINUTE_MS }),
    s('end-2h', { state: 'ended', endedAt: NOW - 2 * HOUR_MS }),
    s('end-10h', { state: 'ended', endedAt: NOW - 10 * HOUR_MS }),
    s('end-25h', { state: 'ended', endedAt: NOW - 25 * HOUR_MS }),
    s('end-null', { state: 'ended', endedAt: null, lastEventAt: NOW - 3 * HOUR_MS }),
  ];

  it('drops ended sessions older than the window (server rule: endedAt > now - window)', () => {
    expect(ids([...withinEndedWindow(list, NOW, endedWindowMs(false))])).toEqual(['live', 'end-recent']);
    expect(ids([...withinEndedWindow(list, NOW, endedWindowMs(true))])).toEqual(['live', 'end-recent', 'end-2h', 'end-10h', 'end-null']);
    const edge = [s('edge', { state: 'ended', endedAt: NOW - HOUR_MS })];
    expect(withinEndedWindow(edge, NOW, HOUR_MS)).toEqual([]);
  });

  it('a snapshot ages out as now advances without a new 200', () => {
    const later = NOW + 40 * MINUTE_MS;
    const g = groupSessions(withinEndedWindow(list, later, endedWindowMs(false)), later);
    expect(g.ended).toEqual([]);
    expect(countGroups(g, later).ended).toBe(0);
  });

  it('returns the same array when nothing is dropped', () => {
    const fresh = list.slice(0, 2);
    expect(withinEndedWindow(fresh, NOW, HOUR_MS)).toBe(fresh);
  });
});

describe('hostsOf', () => {
  it('distinct hosts sorted with totals and waiting counts', () => {
    const r = hostsOf([s('1', { host: 'mac' }), s('2', { host: 'kvm', state: 'blocked' }), s('3', { host: 'kvm' })]);
    expect(r).toEqual([
      { host: 'kvm', total: 2, blocked: 1 },
      { host: 'mac', total: 1, blocked: 0 },
    ]);
  });
});
