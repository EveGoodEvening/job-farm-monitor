// Write-token and read-session auth. Web Crypto only (Workers, Node 24, Vercel).
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { COOKIE_KEY_SALT, COOKIE_MAX_AGE_S, COOKIE_NAME } from '@jfm/core';

const enc = new TextEncoder();

/**
 * Parse `WRITE_TOKENS="label:token,label2:token2"` into `Map<token, label>`.
 * Whitespace around items is ignored. Items without a label or token, and labels
 * containing "/" (they become part of the session key), are skipped.
 */
export function parseWriteTokens(raw?: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const item of raw.split(',')) {
    const i = item.indexOf(':');
    if (i <= 0) continue;
    const label = item.slice(0, i).trim();
    const token = item.slice(i + 1).trim();
    if (!label || !token || label.includes('/')) continue;
    out.set(token, label);
  }
  return out;
}

async function sha256(s: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** Constant-time string compare: SHA-256 both sides, XOR every byte. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authHeader);
  return m?.[1] ?? null;
}

/**
 * Host label for a write request, or null. Compares against every configured
 * token (no early exit) so timing does not reveal which entry matched.
 */
export async function findWriteHost(
  authHeader: string | null | undefined,
  tokens: Map<string, string>,
): Promise<string | null> {
  const token = bearerToken(authHeader);
  if (!token) return null;
  let host: string | null = null;
  for (const [candidate, label] of tokens) {
    if ((await constantTimeEqual(token, candidate)) && host === null) host = label;
  }
  return host;
}

// --- read-session cookie -------------------------------------------------------

const keyCache = new Map<string, Promise<CryptoKey>>();

/** HMAC-SHA256 key derived from READ_TOKEN + COOKIE_KEY_SALT (cached per token). */
function cookieKey(readToken: string): Promise<CryptoKey> {
  let key = keyCache.get(readToken);
  if (!key) {
    key = (async () => {
      const material = await sha256(`${COOKIE_KEY_SALT}\u0000${readToken}`);
      return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ]);
    })();
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(readToken, key);
  }
  return key;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mac(readToken: string, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await cookieKey(readToken), enc.encode(payload));
  return base64url(new Uint8Array(sig));
}

/** Cookie value `<expMs>.<base64url(hmac)>`. */
export async function makeReadCookie(readToken: string, expMs: number): Promise<string> {
  const exp = String(Math.floor(expMs));
  return `${exp}.${await mac(readToken, exp)}`;
}

/**
 * True when `value` was made by makeReadCookie with this READ_TOKEN and has not
 * expired. An empty READ_TOKEN never verifies. Expiries further out than the
 * cookie lifetime (plus a minute of slack) are rejected as well.
 */
export async function verifyReadCookie(
  readToken: string,
  value: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!readToken || !value) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const exp = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d{1,16}$/.test(exp) || !sig) return false;
  const expMs = Number(exp);
  if (expMs <= nowMs || expMs > nowMs + COOKIE_MAX_AGE_S * 1000 + 60_000) return false;
  return constantTimeEqual(sig, await mac(readToken, exp));
}

/** Read auth: valid `jfm_s` cookie or `Authorization: Bearer <READ_TOKEN>`. */
export async function isReadAuthed(c: Context, readToken: string): Promise<boolean> {
  if (!readToken) return false;
  const bearer = bearerToken(c.req.header('authorization'));
  if (bearer !== null && (await constantTimeEqual(bearer, readToken))) return true;
  return verifyReadCookie(readToken, getCookie(c, COOKIE_NAME));
}
