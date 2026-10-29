// Relative time helpers. All "now" values are corrected by serverOffsetMs so
// a skewed browser clock does not distort ages. Readers of `now()` subscribe to
// the `tick` signal and therefore re-render every RELATIVE_TICK_MS.
import { DAY_MS, HOUR_MS, MINUTE_MS, RELATIVE_TICK_MS, SECOND_MS } from '@jfm/core';
import { translate, type Lang } from './i18n.ts';
import { lang, serverOffsetMs, tick } from './state.ts';

const UNITS: readonly [ms: number, suffix: string][] = [
  [DAY_MS, 'd'],
  [HOUR_MS, 'h'],
  [MINUTE_MS, 'm'],
  [SECOND_MS, 's'],
];

/**
 * Compact duration with up to `levels` units, largest first, dropping a zero
 * trailing unit: 45s, 3m 12s, 5m, 2h 5m, 3d 4h. Negative input clamps to 0s.
 * Units are language-neutral on purpose (dense dashboard: "无更新 12m").
 */
export function formatDuration(ms: number, levels = 2): string {
  let rest = Math.max(0, Math.floor(ms));
  const parts: string[] = [];
  for (const [unit, suffix] of UNITS) {
    if (parts.length >= levels) break;
    const n = Math.floor(rest / unit);
    rest -= n * unit;
    if (n > 0) parts.push(`${n}${suffix}`);
    else if (parts.length > 0) break; // keep precision contiguous: "1h" not "1h 5s"
  }
  return parts.length > 0 ? parts.join(' ') : '0s';
}

/** "just now" under 5 s, else "3m 12s ago" / "3m 12s前". Pure. */
export function formatRelative(deltaMs: number, l: Lang, levels = 2): string {
  if (deltaMs < 5 * SECOND_MS) return translate(l, 'justNow');
  return translate(l, 'ago', { d: formatDuration(deltaMs, levels) });
}

/** Skew-corrected server-clock "now"; subscribes the caller to the tick. */
export function now(): number {
  void tick.value;
  return Date.now() + serverOffsetMs.value;
}

/** Relative age of an epoch-ms timestamp in the current language. */
export function relative(ts: number, levels = 2): string {
  return formatRelative(now() - ts, lang.value, levels);
}

/** Time spent since `since` (e.g. stateSince), compact duration. */
export function elapsed(since: number, levels = 2): string {
  return formatDuration(now() - since, levels);
}

/** Absolute local time for detail views. */
export function absolute(ts: number): string {
  return new Date(ts).toLocaleString(lang.value === 'zh' ? 'zh-CN' : 'en-GB', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Start the re-render tick; returns a stop function. */
export function startTicker(): () => void {
  const id = setInterval(() => {
    tick.value++;
  }, RELATIVE_TICK_MS);
  return () => clearInterval(id);
}
