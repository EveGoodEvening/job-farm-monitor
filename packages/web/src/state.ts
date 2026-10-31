// Global dashboard state (Preact signals). Plain module state, no providers.
import { signal } from '@preact/signals';
import type { SessionView } from '@jfm/core';
import type { Lang } from './i18n.ts';
import type { ThemePref } from './theme.ts';

/** Sessions from the latest /api/state snapshot (server order: lastEventAt desc). */
export const sessions = signal<SessionView[]>([]);
/** Revision of the snapshot in `sessions`; null forces a full snapshot. */
export const revision = signal<number | null>(null);
/** serverNow - Date.now() at the last successful poll; corrects client clock skew. */
export const serverOffsetMs = signal(0);
/** null = unknown (checking), true = signed in, false = show the login page. */
export const authed = signal<boolean | null>(null);
/** UI language; initialised by initLang() and persisted by setLang() (i18n.ts). */
export const lang = signal<Lang>('en');
/** Color theme choice; initialised by initTheme() and persisted by setThemePref() (theme.ts). */
export const themePref = signal<ThemePref>('system');
/** Host label filter; null = all hosts. */
export const hostFilter = signal<string | null>(null);
/** false: ended sessions from the last hour (`ended=1h`); true: last 24 h (`ended=24h`). */
export const showEnded = signal(false);

export type ConnState = 'connecting' | 'live' | 'error' | 'paused';
/** Polling health shown in the top bar. */
export const conn = signal<ConnState>('connecting');
/** Client time of the last successful poll (200 or 304). */
export const lastOkAt = signal<number | null>(null);
/** Bumped every RELATIVE_TICK_MS so relative times re-render. */
export const tick = signal(0);
