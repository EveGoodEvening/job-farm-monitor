import type { AgentKind } from './types.js';

/** Composite primary key of `sessions`: `host/agent/sessionId`. */
export function sessionKey(host: string, agent: AgentKind, sessionId: string): string {
  return `${host}/${agent}/${sessionId}`;
}

/**
 * Inverse of sessionKey(). Host labels never contain "/" (they come from
 * WRITE_TOKENS labels); the session id may, so everything after the second
 * slash is the session id. Returns null for malformed keys.
 */
export function parseSessionKey(
  key: string,
): { host: string; agent: string; sessionId: string } | null {
  const a = key.indexOf('/');
  if (a <= 0) return null;
  const b = key.indexOf('/', a + 1);
  if (b <= a + 1 || b === key.length - 1) return null;
  return { host: key.slice(0, a), agent: key.slice(a + 1, b), sessionId: key.slice(b + 1) };
}
