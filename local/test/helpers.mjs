// Shared helpers for the node --test suites in local/test.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EMIT = join(LOCAL_DIR, 'bin', 'jfm-emit');
export const INSTALL = join(LOCAL_DIR, 'install.sh');
export const FIXTURES = join(LOCAL_DIR, 'test', 'fixtures');

export function hasCommand(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

export function tempHome(prefix = 'jfm-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A clean environment: only PATH + HOME (+ extras). Keeps the developer's real
 * HERDR_* / TMUX_* / XDG_* / JFM_* variables out of the tests.
 */
export function cleanEnv(home, extra = {}) {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C', ...extra };
}

/**
 * Run a command asynchronously (the mock server lives in this process, so a
 * synchronous spawn would deadlock on network calls).
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, ms: number }>}
 */
export function run(cmd, args, { env, input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    // 'close' also proves the detached flusher does not keep the hook's stdio open.
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function waitFor(fn, { timeout = 8000, interval = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function stateDir(home) {
  return join(home, '.local', 'state', 'job-farm-mon');
}

export function outboxFiles(home) {
  const dir = join(stateDir(home), 'outbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9].*\.json$/.test(f))
    .sort();
}

/** Wait for any background flusher to release its lock, then delete the temp HOME. */
export async function cleanupHome(home) {
  const lock = join(stateDir(home), 'lock.d');
  try {
    await waitFor(() => !existsSync(lock), { timeout: 5000, what: 'flush lock release' });
  } catch {
    // ignore; remove anyway
  }
  rmSync(home, { recursive: true, force: true });
}
