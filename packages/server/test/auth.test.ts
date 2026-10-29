import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { COOKIE_MAX_AGE_S, COOKIE_NAME } from '@jfm/core';
import {
  bearerToken,
  constantTimeEqual,
  findWriteHost,
  isReadAuthed,
  makeReadCookie,
  parseWriteTokens,
  verifyReadCookie,
} from '../src/auth.js';

const READ = 'r'.repeat(48);
const DAY = 24 * 3600 * 1000;

describe('parseWriteTokens', () => {
  it('parses label:token pairs into token -> label', () => {
    const m = parseWriteTokens(' kvm16188:tokA , macbook:tokB,');
    expect([...m]).toEqual([
      ['tokA', 'kvm16188'],
      ['tokB', 'macbook'],
    ]);
  });

  it('handles empty / missing input', () => {
    expect(parseWriteTokens(undefined).size).toBe(0);
    expect(parseWriteTokens('').size).toBe(0);
    expect(parseWriteTokens(' , ,').size).toBe(0);
  });

  it('skips malformed items and labels containing "/"', () => {
    const m = parseWriteTokens('nolabel,:tok,label:,a/b:tok1,ok:tok:with:colons');
    expect([...m]).toEqual([['tok:with:colons', 'ok']]);
  });
});

describe('constantTimeEqual', () => {
  it('compares strings', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true);
    expect(await constantTimeEqual('abc', 'abd')).toBe(false);
    expect(await constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(await constantTimeEqual('', '')).toBe(true);
  });
});

describe('bearerToken / findWriteHost', () => {
  const tokens = parseWriteTokens('hostA:tokA,hostB:tokB');

  it('extracts Bearer tokens', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer  abc ')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it('returns the host label for a right token, null otherwise', async () => {
    expect(await findWriteHost('Bearer tokA', tokens)).toBe('hostA');
    expect(await findWriteHost('Bearer tokB', tokens)).toBe('hostB');
    expect(await findWriteHost('Bearer tokC', tokens)).toBeNull();
    expect(await findWriteHost('tokA', tokens)).toBeNull();
    expect(await findWriteHost(undefined, tokens)).toBeNull();
  });

  it('empty WRITE_TOKENS never matches', async () => {
    expect(await findWriteHost('Bearer tokA', parseWriteTokens(''))).toBeNull();
    expect(await findWriteHost('Bearer ', parseWriteTokens(''))).toBeNull();
  });
});

describe('read cookie', () => {
  const now = 1_800_000_000_000;

  it('round-trips and has the <exp>.<base64url> shape', async () => {
    const v = await makeReadCookie(READ, now + DAY);
    expect(v).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(v.startsWith(`${now + DAY}.`)).toBe(true);
    expect(await verifyReadCookie(READ, v, now)).toBe(true);
  });

  it('rejects expired cookies', async () => {
    const v = await makeReadCookie(READ, now + DAY);
    expect(await verifyReadCookie(READ, v, now + DAY)).toBe(false);
    expect(await verifyReadCookie(READ, v, now + 2 * DAY)).toBe(false);
  });

  it('rejects expiries beyond the cookie lifetime', async () => {
    const v = await makeReadCookie(READ, now + COOKIE_MAX_AGE_S * 1000 + 10 * 60_000);
    expect(await verifyReadCookie(READ, v, now)).toBe(false);
  });

  it('rejects tampered cookies', async () => {
    const v = await makeReadCookie(READ, now + DAY);
    const [exp, sig] = v.split('.') as [string, string];
    expect(await verifyReadCookie(READ, `${Number(exp) + 1}.${sig}`, now)).toBe(false);
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(await verifyReadCookie(READ, `${exp}.${flipped}`, now)).toBe(false);
    for (const bad of ['', '.', `${exp}.`, `.${sig}`, 'abc.def', `-1.${sig}`, sig]) {
      expect(await verifyReadCookie(READ, bad, now), bad).toBe(false);
    }
  });

  it('is invalidated by changing READ_TOKEN; empty READ_TOKEN never verifies', async () => {
    const v = await makeReadCookie(READ, now + DAY);
    expect(await verifyReadCookie('other-token', v, now)).toBe(false);
    const empty = await makeReadCookie('', now + DAY);
    expect(await verifyReadCookie('', empty, now)).toBe(false);
  });
});

describe('isReadAuthed', () => {
  const app = new Hono();
  app.get('/', async (c) => c.json(await isReadAuthed(c, c.req.query('rt') ?? READ)));
  const check = async (headers: Record<string, string>, rt?: string) =>
    (await (await app.request(rt === undefined ? '/' : `/?rt=${rt}`, { headers })).json()) as boolean;

  it('accepts Bearer READ_TOKEN or a valid cookie', async () => {
    expect(await check({ authorization: `Bearer ${READ}` })).toBe(true);
    const v = await makeReadCookie(READ, Date.now() + DAY);
    expect(await check({ cookie: `other=1; ${COOKIE_NAME}=${v}` })).toBe(true);
  });

  it('rejects wrong / missing credentials', async () => {
    expect(await check({})).toBe(false);
    expect(await check({ authorization: 'Bearer wrong' })).toBe(false);
    expect(await check({ cookie: `${COOKIE_NAME}=1.abc` })).toBe(false);
    const expired = await makeReadCookie(READ, Date.now() - 1);
    expect(await check({ cookie: `${COOKIE_NAME}=${expired}` })).toBe(false);
  });

  it('empty READ_TOKEN rejects everything', async () => {
    expect(await check({ authorization: 'Bearer ' }, '')).toBe(false);
  });
});
