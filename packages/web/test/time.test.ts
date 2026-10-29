import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@jfm/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lang, serverOffsetMs, tick } from '../src/state.ts';
import { elapsed, formatDuration, formatRelative, now, relative } from '../src/time.ts';

afterEach(() => {
  vi.useRealTimers();
  serverOffsetMs.value = 0;
  lang.value = 'en';
});

describe('formatDuration (two-level precision)', () => {
  it.each([
    [0, '0s'],
    [-5000, '0s'],
    [999, '0s'],
    [SECOND_MS, '1s'],
    [59 * SECOND_MS, '59s'],
    [60 * SECOND_MS, '1m'],
    [61 * SECOND_MS, '1m 1s'],
    [3 * MINUTE_MS + 12 * SECOND_MS, '3m 12s'],
    [59 * MINUTE_MS + 59 * SECOND_MS, '59m 59s'],
    [HOUR_MS, '1h'],
    [HOUR_MS + 30 * SECOND_MS, '1h'], // contiguous units only
    [2 * HOUR_MS + 5 * MINUTE_MS + 9 * SECOND_MS, '2h 5m'],
    [DAY_MS - 1, '23h 59m'],
    [DAY_MS, '1d'],
    [3 * DAY_MS + 4 * HOUR_MS + 7 * MINUTE_MS, '3d 4h'],
  ])('%i ms -> %s', (ms, out) => {
    expect(formatDuration(ms)).toBe(out);
  });

  it('levels=1 keeps only the largest unit', () => {
    expect(formatDuration(3 * MINUTE_MS + 12 * SECOND_MS, 1)).toBe('3m');
    expect(formatDuration(25 * HOUR_MS, 1)).toBe('1d');
    expect(formatDuration(12 * SECOND_MS, 1)).toBe('12s');
  });
});

describe('formatRelative', () => {
  it('just now under 5 s, in both languages', () => {
    expect(formatRelative(0, 'en')).toBe('just now');
    expect(formatRelative(4999, 'en')).toBe('just now');
    expect(formatRelative(-30_000, 'zh')).toBe('刚刚'); // future (clock skew) clamps
    expect(formatRelative(4999, 'zh')).toBe('刚刚');
  });
  it('ago suffix', () => {
    expect(formatRelative(5000, 'en')).toBe('5s ago');
    expect(formatRelative(5000, 'zh')).toBe('5s前');
    expect(formatRelative(3 * MINUTE_MS + 12 * SECOND_MS, 'en')).toBe('3m 12s ago');
    expect(formatRelative(3 * MINUTE_MS + 12 * SECOND_MS, 'zh', 1)).toBe('3m前');
    expect(formatRelative(2 * DAY_MS + 3 * HOUR_MS, 'zh')).toBe('2d 3h前');
  });
});

describe('server clock correction', () => {
  it('now() adds serverOffsetMs; relative/elapsed use it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    serverOffsetMs.value = 90 * SECOND_MS; // server is 90 s ahead of this browser
    expect(now()).toBe(1_000_000_000_000 + 90_000);
    const ts = 1_000_000_000_000; // event stamped by server-ish clock at client "now"
    expect(elapsed(ts)).toBe('1m 30s');
    lang.value = 'en';
    expect(relative(ts)).toBe('1m 30s ago');
    lang.value = 'zh';
    expect(relative(ts, 1)).toBe('1m前');
    serverOffsetMs.value = -90 * SECOND_MS; // browser ahead: ages never go negative
    expect(elapsed(ts)).toBe('0s');
    expect(relative(ts)).toBe('刚刚');
  });

  it('now() reads the tick signal (re-render hook)', async () => {
    const { effect } = await import('@preact/signals');
    let runs = 0;
    const dispose = effect(() => {
      now();
      runs++;
    });
    tick.value++;
    dispose();
    expect(runs).toBe(2);
  });
});
