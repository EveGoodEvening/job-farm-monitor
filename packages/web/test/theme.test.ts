import { readFileSync } from 'node:fs';
import { THEME_STORAGE_KEY } from '@jfm/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { themePref } from '../src/state.ts';
import { initTheme, nextThemePref, parseThemePref, resolveTheme, setThemePref, THEME_COLORS } from '../src/theme.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

function fakeMeta(media: string) {
  return { media, content: '' };
}

/** Minimal document + matchMedia: enough for theme.ts's apply(). */
function fakeDom(systemDark: boolean) {
  const listeners: (() => void)[] = [];
  const mq = {
    matches: systemDark,
    addEventListener: (_: string, f: () => void) => void listeners.push(f),
  };
  const metas = [fakeMeta('(prefers-color-scheme: light)'), fakeMeta('(prefers-color-scheme: dark)')];
  const root = { dataset: {} as Record<string, string> };
  vi.stubGlobal('matchMedia', () => mq);
  vi.stubGlobal('document', { documentElement: root, querySelectorAll: () => metas });
  return {
    root,
    metas,
    flip(dark: boolean) {
      mq.matches = dark;
      for (const f of listeners) f();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  themePref.value = 'system';
});

describe('pure helpers', () => {
  it('parses only light/dark; anything else follows the system', () => {
    expect(parseThemePref('light')).toBe('light');
    expect(parseThemePref('dark')).toBe('dark');
    for (const v of [null, undefined, '', 'system', 'DARK', 'auto']) expect(parseThemePref(v)).toBe('system');
  });

  it('resolves system against the media query; a forced choice wins', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('cycles system -> light -> dark -> system', () => {
    expect(nextThemePref('system')).toBe('light');
    expect(nextThemePref('light')).toBe('dark');
    expect(nextThemePref('dark')).toBe('system');
  });
});

describe('initTheme / setThemePref', () => {
  it('follows the system by default and tracks its changes', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const dom = fakeDom(true);
    initTheme();
    expect(themePref.value).toBe('system');
    expect(dom.root.dataset.theme).toBe('dark');
    expect(dom.metas.map((m) => m.content)).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
    dom.flip(false);
    expect(dom.root.dataset.theme).toBe('light');
  });

  it('a stored choice overrides the system and ignores its changes', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [THEME_STORAGE_KEY]: 'light' }));
    const dom = fakeDom(true);
    initTheme();
    expect(themePref.value).toBe('light');
    expect(dom.root.dataset.theme).toBe('light');
    expect(dom.metas.map((m) => m.content)).toEqual([THEME_COLORS.light, THEME_COLORS.light]);
    dom.flip(false);
    dom.flip(true);
    expect(dom.root.dataset.theme).toBe('light');
  });

  it('persists light/dark and clears the key for system', () => {
    const st = fakeStorage();
    vi.stubGlobal('localStorage', st);
    const dom = fakeDom(false);
    initTheme();
    setThemePref('dark');
    expect(st.map.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(dom.root.dataset.theme).toBe('dark');
    expect(dom.metas.map((m) => m.content)).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);
    setThemePref('system');
    expect(st.map.has(THEME_STORAGE_KEY)).toBe(false);
    expect(dom.root.dataset.theme).toBe('light');
  });

  it('survives blocked storage and a missing DOM', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => initTheme()).not.toThrow();
    expect(() => setThemePref('dark')).not.toThrow();
    expect(themePref.value).toBe('dark');
  });
});

describe('index.html pre-paint script and styles stay in sync', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

  it('reads the same storage key and sets data-theme', () => {
    expect(html).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
    expect(html).toContain("setAttribute('data-theme', t)");
  });

  it('theme-color metas and --bg match THEME_COLORS', () => {
    expect(html).toContain(`content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)"`);
    expect(html).toContain(`content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)"`);
    const light = /:root \{[^}]*--bg: (#[0-9a-f]+);/.exec(css)?.[1];
    const dark = /:root\[data-theme='dark'\] \{[^}]*--bg: (#[0-9a-f]+);/.exec(css)?.[1];
    expect(light).toBe(THEME_COLORS.light);
    expect(dark).toBe(THEME_COLORS.dark);
  });

  it('dark tokens are keyed on data-theme, not the media query', () => {
    expect(css).not.toMatch(/@media \(prefers-color-scheme/);
  });
});
