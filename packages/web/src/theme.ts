// Color theme: follow the system (default), or a stored light/dark choice in
// localStorage[THEME_STORAGE_KEY]. The resolved theme lives on
// <html data-theme="light|dark">, which styles.css keys the dark tokens on.
// index.html's inline script sets it before first paint; initTheme() takes over.
import { THEME_STORAGE_KEY } from '@jfm/core';
import { themePref } from './state.ts';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
/** Toggle order: system -> light -> dark -> system. */
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];
/** Browser chrome color per theme; must equal --bg in styles.css and the index.html metas. */
export const THEME_COLORS: Record<Theme, string> = { light: '#f9f9fb', dark: '#0f1012' };

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function parseThemePref(stored: string | null | undefined): ThemePref {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}

export function nextThemePref(pref: ThemePref): ThemePref {
  return THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length] ?? 'system';
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function darkQuery(): MediaQueryList | undefined {
  try {
    return globalThis.matchMedia?.(DARK_QUERY);
  } catch {
    return undefined;
  }
}

/** Write the resolved theme to <html> and the theme-color metas. */
function apply(pref: ThemePref): void {
  if (typeof document === 'undefined') return;
  const theme = resolveTheme(pref, darkQuery()?.matches ?? false);
  document.documentElement.dataset.theme = theme;
  // The metas carry media="(prefers-color-scheme: …)". Following the system, each
  // keeps its own color; with a forced theme both get it, whichever media matches.
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own: Theme = m.media.includes('dark') ? 'dark' : 'light';
    m.content = THEME_COLORS[pref === 'system' ? own : theme];
  }
}

/** Read the stored choice, apply it and follow system changes. Call once at startup. */
export function initTheme(): void {
  let stored: string | null;
  try {
    stored = storage()?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  themePref.value = parseThemePref(stored);
  apply(themePref.value);
  darkQuery()?.addEventListener?.('change', () => {
    if (themePref.value === 'system') apply('system');
  });
}

export function setThemePref(pref: ThemePref): void {
  themePref.value = pref;
  apply(pref);
  try {
    if (pref === 'system') storage()?.removeItem(THEME_STORAGE_KEY);
    else storage()?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // private mode / blocked storage: keep the in-memory choice only
  }
}
