// Pure section grouping / ordering for the dashboard (unit-tested).
import { ENDED_WINDOWS, STALE_MS } from '@jfm/core';
import type { SessionView } from '@jfm/core';

export type SectionId = 'blocked' | 'working' | 'rest' | 'ended';
export const SECTION_ORDER: readonly SectionId[] = ['blocked', 'working', 'rest', 'ended'];

export interface Grouped {
  blocked: SessionView[];
  working: SessionView[];
  rest: SessionView[];
  ended: SessionView[];
}

export interface Counts {
  blocked: number;
  working: number;
  stale: number;
  /** done + idle (the "rest" section minus errors) */
  rest: number;
  error: number;
  ended: number;
}

/** Ended-session window in ms: 1 h by default, 24 h when "show ended 24 h" is on. */
export function endedWindowMs(showEnded24h: boolean): number {
  return showEnded24h ? ENDED_WINDOWS['24h'] : ENDED_WINDOWS['1h'];
}

/**
 * Drop ended sessions that fell out of the window since the last 200 snapshot.
 * The server only applies `ended=` on a 200; a quiet farm answers 304 forever,
 * so the client re-applies the same rule (`endedAt > now - window`, server
 * clock) on every render. Returns the input unchanged when nothing is dropped.
 */
export function withinEndedWindow(list: readonly SessionView[], now: number, windowMs: number): readonly SessionView[] {
  const cutoff = now - windowMs;
  const keep = (s: SessionView) => s.state !== 'ended' || (s.endedAt ?? s.lastEventAt) > cutoff;
  return list.every(keep) ? list : list.filter(keep);
}

/** working/blocked with no event for more than STALE_MS (server-clock `now`). */
export function isStale(s: Pick<SessionView, 'state' | 'lastEventAt'>, now: number): boolean {
  return (s.state === 'working' || s.state === 'blocked') && now - s.lastEventAt > STALE_MS;
}

export function sectionOf(s: Pick<SessionView, 'state'>): SectionId {
  switch (s.state) {
    case 'blocked':
      return 'blocked';
    case 'working':
      return 'working';
    case 'ended':
      return 'ended';
    default:
      return 'rest'; // done, idle, error
  }
}

const byLastEventDesc = (a: SessionView, b: SessionView) => b.lastEventAt - a.lastEventAt || cmpKey(a, b);
const cmpKey = (a: SessionView, b: SessionView) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Split sessions into sections and order each one:
 * - blocked: longest wait first (stateSince asc).
 * - working: stale first, then most recent activity first.
 * - rest: errors first, then most recent activity first.
 * - ended: most recently ended first.
 * `host` filters by host label (null = all). Input is not mutated.
 */
export function groupSessions(list: readonly SessionView[], now: number, host: string | null = null): Grouped {
  const g: Grouped = { blocked: [], working: [], rest: [], ended: [] };
  for (const s of list) {
    if (host !== null && s.host !== host) continue;
    g[sectionOf(s)].push(s);
  }
  g.blocked.sort((a, b) => a.stateSince - b.stateSince || cmpKey(a, b));
  g.working.sort((a, b) => Number(isStale(b, now)) - Number(isStale(a, now)) || byLastEventDesc(a, b));
  g.rest.sort((a, b) => Number(b.state === 'error') - Number(a.state === 'error') || byLastEventDesc(a, b));
  g.ended.sort((a, b) => (b.endedAt ?? b.lastEventAt) - (a.endedAt ?? a.lastEventAt) || cmpKey(a, b));
  return g;
}

export function countGroups(g: Grouped, now: number): Counts {
  return {
    blocked: g.blocked.length,
    working: g.working.length,
    stale: g.working.filter((s) => isStale(s, now)).length + g.blocked.filter((s) => isStale(s, now)).length,
    rest: g.rest.filter((s) => s.state !== 'error').length,
    error: g.rest.filter((s) => s.state === 'error').length,
    ended: g.ended.length,
  };
}

/** Distinct host labels, sorted, with how many sessions are waiting on each. */
export function hostsOf(list: readonly SessionView[]): { host: string; total: number; blocked: number }[] {
  const m = new Map<string, { host: string; total: number; blocked: number }>();
  for (const s of list) {
    const h = m.get(s.host) ?? { host: s.host, total: 0, blocked: 0 };
    h.total++;
    if (s.state === 'blocked') h.blocked++;
    m.set(s.host, h);
  }
  return [...m.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}
