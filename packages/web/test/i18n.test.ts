import { LANG_STORAGE_KEY } from '@jfm/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DICTS, detectLang, initLang, LANGS, setLang, t, translate, type MsgKey } from '../src/i18n.ts';
import { lang } from '../src/state.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  lang.value = 'en';
});

describe('dictionaries', () => {
  it('zh and en have exactly the same keys, all non-empty', () => {
    const en = Object.keys(DICTS.en).sort();
    expect(Object.keys(DICTS.zh).sort()).toEqual(en);
    for (const l of LANGS) for (const k of en) expect(DICTS[l][k as MsgKey].length).toBeGreaterThan(0);
  });

  it('zh and en use the same {placeholders} per key', () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(DICTS.en) as MsgKey[]) expect(ph(DICTS.zh[k]), k).toEqual(ph(DICTS.en[k]));
  });

  it('covers every state and section label', () => {
    for (const s of ['idle', 'working', 'blocked', 'done', 'error', 'ended', 'stale']) {
      expect(DICTS.en).toHaveProperty(`state.${s}`);
    }
    for (const s of ['blocked', 'working', 'rest', 'ended']) expect(DICTS.zh).toHaveProperty(`section.${s}`);
  });
});

describe('translate / t', () => {
  it('interpolates params in both languages', () => {
    expect(translate('en', 'stale', { d: '12m' })).toBe('no update for 12m');
    expect(translate('zh', 'stale', { d: '12m' })).toBe('无更新 12m');
    expect(translate('en', 'delayed')).toBe('delayed');
    expect(translate('zh', 'delayed')).toBe('延迟送达');
    expect(translate('zh', 'subagents', { n: 2, types: 'Explore, Plan' })).toBe('↳ 2 个 subagent：Explore, Plan');
  });

  it('leaves unknown placeholders intact', () => {
    expect(translate('en', 'ago', {})).toBe('{d} ago');
  });

  it('t() follows the lang signal', () => {
    lang.value = 'en';
    expect(t('state.blocked')).toBe('Waiting');
    lang.value = 'zh';
    expect(t('state.blocked')).toBe('等待中');
  });
});

describe('detectLang', () => {
  it('stored value wins', () => {
    expect(detectLang('en', 'zh-CN')).toBe('en');
    expect(detectLang('zh', 'en-US')).toBe('zh');
  });
  it('falls back to navigator.language: zh* -> zh, else en', () => {
    expect(detectLang(null, 'zh-CN')).toBe('zh');
    expect(detectLang(null, 'zh-Hant-TW')).toBe('zh');
    expect(detectLang(null, 'ZH')).toBe('zh');
    expect(detectLang(null, 'en-GB')).toBe('en');
    expect(detectLang(null, 'ja')).toBe('en');
    expect(detectLang(null, undefined)).toBe('en');
    expect(detectLang('fr', 'zh-CN')).toBe('zh'); // garbage stored value ignored
  });
});

describe('persistence', () => {
  it('setLang writes localStorage["jfm.lang"]; initLang reads it back', () => {
    expect(LANG_STORAGE_KEY).toBe('jfm.lang');
    const st = fakeStorage();
    vi.stubGlobal('localStorage', st);
    setLang('zh');
    expect(st.map.get('jfm.lang')).toBe('zh');
    lang.value = 'en';
    initLang();
    expect(lang.value).toBe('zh');
  });

  it('survives a throwing localStorage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    vi.stubGlobal('navigator', { language: 'zh-TW' });
    expect(() => setLang('en')).not.toThrow();
    expect(lang.value).toBe('en');
    initLang();
    expect(lang.value).toBe('zh');
  });
});
