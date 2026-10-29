// install.sh / merge-hooks.jq tests (T31, T32, T34). Always a temporary HOME; the
// fixtures are sanitized copies of real ~/.claude/settings.json, ~/.codex/hooks.json
// and ~/.codex/config.toml (heavy-gate, commit-attribution and herdr hooks).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  FIXTURES,
  INSTALL,
  LOCAL_DIR,
  cleanEnv,
  cleanupHome,
  run,
  tempHome,
} from './helpers.mjs';
import { startMockServer } from './mock-server.mjs';

const CLAUDE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'SessionEnd',
];
const CODEX_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd', 'Interrupt',
];
const OMP_SRC = join(LOCAL_DIR, 'omp', 'job-farm-monitor.ts');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const read = (p) => readFileSync(p, 'utf8');
const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const isJfm = (h) => typeof h?.command === 'string' && h.command.includes('jfm-emit');

function fixtureHome() {
  const home = tempHome('jfm-install-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.omp', 'agent', 'extensions'), { recursive: true });
  copyFileSync(join(FIXTURES, 'claude-settings.json'), join(home, '.claude', 'settings.json'));
  copyFileSync(join(FIXTURES, 'codex-hooks.json'), join(home, '.codex', 'hooks.json'));
  copyFileSync(join(FIXTURES, 'codex-config.toml'), join(home, '.codex', 'config.toml'));
  copyFileSync(
    join(FIXTURES, 'omp-herdr-extension.ts'),
    join(home, '.omp', 'agent', 'extensions', 'herdr-omp-agent-state.ts'),
  );
  return home;
}

const paths = (home) => ({
  claude: join(home, '.claude', 'settings.json'),
  codex: join(home, '.codex', 'hooks.json'),
  codexToml: join(home, '.codex', 'config.toml'),
  emit: join(home, '.local', 'bin', 'jfm-emit'),
  config: join(home, '.config', 'job-farm-monitor', 'config'),
  state: join(home, '.local', 'state', 'job-farm-monitor'),
  ompExt: join(home, '.omp', 'agent', 'extensions', 'job-farm-monitor.ts'),
  herdrExt: join(home, '.omp', 'agent', 'extensions', 'herdr-omp-agent-state.ts'),
});

const install = (home, args = []) => run('bash', [INSTALL, ...args], { env: cleanEnv(home) });

describe('hook fragments', () => {
  test('claude.hooks.json: 13 events, async except a synchronous SessionEnd', () => {
    const frag = readJson(join(LOCAL_DIR, 'claude.hooks.json'));
    assert.deepEqual(Object.keys(frag), ['hooks']);
    assert.deepEqual(Object.keys(frag.hooks).sort(), [...CLAUDE_EVENTS].sort());
    for (const ev of CLAUDE_EVENTS) {
      const groups = frag.hooks[ev];
      assert.equal(groups.length, 1, ev);
      assert.equal('matcher' in groups[0], false, `${ev} has no matcher`);
      assert.equal(groups[0].hooks.length, 1);
      const h = groups[0].hooks[0];
      if (ev === 'SessionEnd') {
        assert.deepEqual(h, { type: 'command', command: '~/.local/bin/jfm-emit claude', timeout: 3 });
      } else {
        assert.deepEqual(h, { type: 'command', command: '~/.local/bin/jfm-emit claude', async: true, timeout: 5 });
      }
    }
  });

  test('codex.hooks.json: 11 events, SessionEnd/Interrupt synchronous with 1 s timeout', () => {
    const frag = readJson(join(LOCAL_DIR, 'codex.hooks.json'));
    assert.deepEqual(Object.keys(frag.hooks).sort(), [...CODEX_EVENTS].sort());
    for (const ev of CODEX_EVENTS) {
      const [group] = frag.hooks[ev];
      assert.equal(frag.hooks[ev].length, 1);
      const [h] = group.hooks;
      if (ev === 'SessionEnd' || ev === 'Interrupt') {
        assert.deepEqual(h, { type: 'command', command: '~/.local/bin/jfm-emit codex', timeout: 1 });
      } else {
        assert.deepEqual(h, {
          type: 'command',
          command: '~/.local/bin/jfm-emit codex',
          async: true,
          timeout: 5,
          statusMessage: 'job-farm-monitor',
        });
      }
    }
  });
});

describe('install.sh', () => {
  /** @type {Awaited<ReturnType<typeof startMockServer>>} */
  let server;
  before(async () => {
    server = await startMockServer();
  });
  after(async () => {
    await server.close();
  });

  test('bash -n syntax check', async () => {
    const r = await run('bash', ['-n', INSTALL]);
    assert.equal(r.code, 0, r.stderr);
  });

  test('install, re-install (idempotent), uninstall restores the original configs', async () => {
    const home = fixtureHome();
    const p = paths(home);
    const orig = {
      claude: read(p.claude),
      codex: read(p.codex),
      toml: read(p.codexToml),
    };
    try {
      const r = await install(home, ['--endpoint', `${server.url}/`, '--token', 'tok-abc123']);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /\/hooks/, 'tells the user to trust hooks in Codex');
      assert.match(r.stdout, /jfm-emit --check/);
      assert.doesNotMatch(r.stdout, /enable Codex hooks/, 'config.toml already has hooks = true');

      // Config: 0600, endpoint without trailing slash.
      assert.equal(statSync(p.config).mode & 0o777, 0o600);
      const cfg = read(p.config);
      assert.match(cfg, new RegExp(`^JFM_ENDPOINT='${server.url}'$`, 'm'));
      assert.match(cfg, /^JFM_WRITE_TOKEN='tok-abc123'$/m);
      assert.ok(!r.stdout.includes('tok-abc123'), 'token not echoed');

      // Reporter.
      assert.equal(statSync(p.emit).mode & 0o777, 0o755);
      assert.equal(read(p.emit), read(join(LOCAL_DIR, 'bin', 'jfm-emit')));

      // Claude: existing PreToolUse groups kept first and intact, ours appended, other keys untouched.
      const origClaude = JSON.parse(orig.claude);
      const claude = readJson(p.claude);
      assert.deepEqual(Object.keys(claude.hooks).sort(), [...CLAUDE_EVENTS].sort());
      assert.deepEqual(claude.hooks.PreToolUse.slice(0, 2), origClaude.hooks.PreToolUse);
      assert.equal(claude.hooks.PreToolUse.length, 3);
      for (const ev of CLAUDE_EVENTS) {
        assert.equal(claude.hooks[ev].filter((g) => g.hooks.some(isJfm)).length, 1, ev);
      }
      const { hooks: _h1, ...claudeRest } = claude;
      const { hooks: _h2, ...origClaudeRest } = origClaude;
      assert.deepEqual(claudeRest, origClaudeRest);
      assert.ok(existsSync(`${p.claude}.bak-jfm`));
      assert.equal(read(`${p.claude}.bak-jfm`), orig.claude);

      // Codex: heavy-gate PreToolUse + herdr SessionStart still first.
      const origCodex = JSON.parse(orig.codex);
      const codex = readJson(p.codex);
      assert.deepEqual(Object.keys(codex.hooks).sort(), [...CODEX_EVENTS].sort());
      assert.deepEqual(codex.hooks.PreToolUse[0], origCodex.hooks.PreToolUse[0]);
      assert.deepEqual(codex.hooks.SessionStart[0], origCodex.hooks.SessionStart[0]);
      assert.equal(codex.hooks.SessionStart.length, 2);
      assert.equal(read(p.codexToml), orig.toml, 'config.toml is never edited');

      // OMP extension (owned by another worker; only checked when present).
      if (existsSync(OMP_SRC)) {
        assert.equal(read(p.ompExt), read(OMP_SRC));
        assert.equal(statSync(p.ompExt).mode & 0o777, 0o644);
      } else {
        assert.equal(existsSync(p.ompExt), false);
      }
      assert.ok(existsSync(p.herdrExt));

      // Re-install without arguments: no duplicates, files byte-identical, config kept.
      const snap = { claude: read(p.claude), codex: read(p.codex), cfg: read(p.config) };
      const r2 = await install(home);
      assert.equal(r2.code, 0, r2.stderr);
      assert.match(r2.stdout, /kept existing config/);
      assert.equal(read(p.claude), snap.claude);
      assert.equal(read(p.codex), snap.codex);
      assert.equal(read(p.config), snap.cfg);

      // The installed reporter works with the written config.
      const check = await run(p.emit, ['--check'], { env: cleanEnv(home) });
      assert.equal(check.code, 0, check.stderr);
      assert.match(check.stdout, /HTTP 200/);
      assert.equal(server.state.requests.at(-1)?.headers.authorization, 'Bearer tok-abc123');

      // Uninstall: configs back to the original documents.
      const u = await install(home, ['--uninstall']);
      assert.equal(u.code, 0, u.stderr);
      assert.deepEqual(readJson(p.claude), origClaude);
      assert.deepEqual(readJson(p.codex), origCodex);
      assert.equal(read(p.codexToml), orig.toml);
      assert.equal(existsSync(p.emit), false);
      assert.equal(existsSync(p.ompExt), false);
      assert.ok(existsSync(p.herdrExt), 'foreign extension kept');
      assert.ok(existsSync(p.config), 'config kept without --purge');
    } finally {
      await cleanupHome(home);
    }
  });

  test('replaces stale jfm-emit hooks, even inside a mixed group', async () => {
    const home = fixtureHome();
    const p = paths(home);
    try {
      const settings = readJson(p.claude);
      settings.hooks.Stop = [
        {
          hooks: [
            { type: 'command', command: 'echo keep-me' },
            { type: 'command', command: '/old/path/jfm-emit claude', timeout: 9 },
          ],
        },
      ];
      writeFileSync(p.claude, JSON.stringify(settings, null, 2) + '\n');
      const r = await install(home, ['--endpoint', 'https://jfm.example.dev', '--token', 't1', '--no-codex', '--no-omp']);
      assert.equal(r.code, 0, r.stderr);
      const stop = readJson(p.claude).hooks.Stop;
      assert.equal(stop.length, 2);
      assert.deepEqual(stop[0], { hooks: [{ type: 'command', command: 'echo keep-me' }] });
      assert.equal(stop[1].hooks[0].command, '~/.local/bin/jfm-emit claude');
      assert.equal(JSON.stringify(stop).includes('/old/path'), false);
      assert.equal(read(p.codex), read(join(FIXTURES, 'codex-hooks.json')), '--no-codex respected');
      assert.equal(existsSync(p.ompExt), false, '--no-omp respected');
    } finally {
      await cleanupHome(home);
    }
  });

  test('symlinked settings.json / hooks.json stay links (readlink without -f, relative chains)', async () => {
    const home = fixtureHome();
    const p = paths(home);
    try {
      // dotfiles/claude/settings.json <- dotfiles/claude-link.json <- ~/.claude/settings.json (relative hops)
      const dot = join(home, 'dotfiles');
      mkdirSync(join(dot, 'claude'), { recursive: true });
      mkdirSync(join(dot, 'codex'), { recursive: true });
      copyFileSync(p.claude, join(dot, 'claude', 'settings.json'));
      copyFileSync(p.codex, join(dot, 'codex', 'hooks.json'));
      rmSync(p.claude);
      rmSync(p.codex);
      symlinkSync('claude/settings.json', join(dot, 'claude-link.json'));
      symlinkSync('../dotfiles/claude-link.json', p.claude);
      symlinkSync(join(dot, 'codex', 'hooks.json'), p.codex);

      // BSD readlink before macOS 12.3: `-f` is an illegal option.
      const shim = join(home, 'shim');
      mkdirSync(shim);
      const realReadlink = spawnSync('sh', ['-c', 'command -v readlink'], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(
        join(shim, 'readlink'),
        `#!/bin/sh\ncase $1 in -*) echo "readlink: illegal option -- \${1#-}" >&2; exit 1 ;; esac\nexec ${realReadlink} "$@"\n`,
        { mode: 0o755 },
      );
      const env = cleanEnv(home, { PATH: `${shim}:${process.env.PATH ?? '/usr/bin:/bin'}` });
      const r = await run('bash', [INSTALL, '--endpoint', 'https://jfm.example.dev', '--token', 't1', '--no-omp'], { env });
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.ok(lstatSync(p.claude).isSymbolicLink(), '~/.claude/settings.json is still a symlink');
      assert.ok(lstatSync(join(dot, 'claude-link.json')).isSymbolicLink(), 'intermediate link kept');
      assert.ok(lstatSync(p.codex).isSymbolicLink(), '~/.codex/hooks.json is still a symlink');
      const target = readJson(join(dot, 'claude', 'settings.json'));
      assert.equal(target.hooks.Stop.filter((g) => g.hooks.some(isJfm)).length, 1, 'the link target was edited');
      assert.ok(readJson(join(dot, 'codex', 'hooks.json')).hooks.Interrupt.some((g) => g.hooks.some(isJfm)));
      assert.ok(existsSync(join(dot, 'claude', 'settings.json.bak-jfm')), 'backup next to the target');
      assert.equal(existsSync(`${p.claude}.bak-jfm`), false, 'no backup next to the link');

      const u = await run('bash', [INSTALL, '--uninstall', '--no-omp'], { env });
      assert.equal(u.code, 0, u.stderr);
      assert.ok(lstatSync(p.claude).isSymbolicLink());
      assert.equal(JSON.stringify(readJson(p.claude)).includes('jfm-emit'), false);
    } finally {
      await cleanupHome(home);
    }
  });

  test('fresh HOME: creates missing files; hints when Codex hooks are off; --purge', async () => {
    const home = tempHome('jfm-install-');
    const p = paths(home);
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    try {
      const r = await install(home, ['--endpoint', 'https://jfm.example.dev', '--token', 't2']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /enable Codex hooks/);
      assert.match(r.stdout, /skipped oh-my-pi/);
      assert.deepEqual(Object.keys(readJson(p.claude).hooks).sort(), [...CLAUDE_EVENTS].sort());
      assert.deepEqual(Object.keys(readJson(p.codex).hooks).sort(), [...CODEX_EVENTS].sort());

      // Updating only the token keeps the endpoint and extra lines.
      writeFileSync(p.config, read(p.config) + 'JFM_REDACT=1\n');
      const r2 = await install(home, ['--token', 't3']);
      assert.equal(r2.code, 0, r2.stderr);
      const cfg = read(p.config);
      assert.match(cfg, /^JFM_ENDPOINT='https:\/\/jfm.example.dev'$/m);
      assert.match(cfg, /^JFM_WRITE_TOKEN='t3'$/m);
      assert.doesNotMatch(cfg, /t2/);
      assert.match(cfg, /^JFM_REDACT=1$/m);
      assert.equal(statSync(p.config).mode & 0o777, 0o600);

      mkdirSync(join(p.state, 'outbox'), { recursive: true });
      const u = await install(home, ['--uninstall', '--purge']);
      assert.equal(u.code, 0, u.stderr);
      assert.deepEqual(readJson(p.claude), {});
      assert.deepEqual(readJson(p.codex), {});
      assert.equal(existsSync(p.config), false);
      assert.equal(existsSync(p.state), false);
      assert.equal(existsSync(p.emit), false);
    } finally {
      await cleanupHome(home);
    }
  });

  test('migrates an install from the old name job-farm-mon', async () => {
    const home = fixtureHome();
    const p = paths(home);
    const legacyConfigDir = join(home, '.config', 'job-farm-mon');
    const legacyState = join(home, '.local', 'state', 'job-farm-mon');
    const legacyExt = join(home, '.omp', 'agent', 'extensions', 'job-farm-mon.ts');
    try {
      mkdirSync(legacyConfigDir, { recursive: true });
      writeFileSync(
        join(legacyConfigDir, 'config'),
        `JFM_ENDPOINT='${server.url}'\nJFM_WRITE_TOKEN='tok-legacy'\nJFM_REDACT=1\n`,
        { mode: 0o644 },
      );
      mkdirSync(join(legacyState, 'outbox'), { recursive: true });
      writeFileSync(join(legacyState, 'outbox', '1700000000000-1-a.json'), '{"queued":1}\n');
      // A lock left by a flusher that is gone (no such pid): dropped on migration.
      mkdirSync(join(legacyState, 'lock.d'));
      writeFileSync(join(legacyState, 'lock.d', 'pid'), '999999999\n');
      writeFileSync(legacyExt, '// old extension\n');

      const r = await install(home);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /migrated: .*job-farm-mon -> .*job-farm-monitor/);
      assert.match(r.stdout, /kept existing config/);

      // Config moved before write_config: endpoint/token/extra lines kept, 0600 enforced.
      // The legacy paths become relative symlinks for reporters that are still running.
      assert.ok(lstatSync(legacyConfigDir).isSymbolicLink());
      assert.equal(readlinkSync(legacyConfigDir), 'job-farm-monitor');
      const cfg = read(p.config);
      assert.match(cfg, /^JFM_WRITE_TOKEN='tok-legacy'$/m);
      assert.match(cfg, /^JFM_REDACT=1$/m);
      assert.equal(statSync(p.config).mode & 0o777, 0o600);

      // State moved with its outbox; the dead lock is gone.
      assert.equal(readlinkSync(legacyState), 'job-farm-monitor');
      assert.equal(read(join(legacyState, 'outbox', '1700000000000-1-a.json')), '{"queued":1}\n');
      assert.equal(read(join(p.state, 'outbox', '1700000000000-1-a.json')), '{"queued":1}\n');
      assert.equal(existsSync(join(p.state, 'lock.d')), false);

      // Old omp extension removed so oh-my-pi does not load both.
      assert.equal(existsSync(legacyExt), false);
      if (existsSync(OMP_SRC)) assert.ok(existsSync(p.ompExt));
      assert.ok(existsSync(p.herdrExt));

      const check = await run(p.emit, ['--check'], { env: cleanEnv(home) });
      assert.equal(check.code, 0, check.stderr);
      assert.equal(server.state.requests.at(-1)?.headers.authorization, 'Bearer tok-legacy');

      // Re-install: nothing left to migrate.
      const r2 = await install(home);
      assert.equal(r2.code, 0, r2.stderr);
      assert.doesNotMatch(r2.stdout, /migrated|NOTE|job-farm-mon\b/);

      // Uninstall drops the compatibility symlinks and keeps the real dirs.
      const u = await install(home, ['--uninstall']);
      assert.equal(u.code, 0, u.stderr);
      for (const d of [legacyConfigDir, legacyState]) assert.equal(existsSync(d) || isLink(d), false, d);
      assert.ok(existsSync(p.config));
    } finally {
      await cleanupHome(home);
    }
  });

  test('migration keeps a running flusher lock and the new dirs when both exist', async () => {
    const home = tempHome('jfm-install-');
    const p = paths(home);
    const legacyConfigDir = join(home, '.config', 'job-farm-mon');
    const legacyState = join(home, '.local', 'state', 'job-farm-mon');
    try {
      // Only the state dir is legacy; its lock belongs to a live process.
      mkdirSync(join(legacyState, 'lock.d'), { recursive: true });
      writeFileSync(join(legacyState, 'lock.d', 'pid'), `${process.pid}\n`);
      const r = await install(home, ['--endpoint', 'https://jfm.example.dev', '--token', 't1']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(read(join(p.state, 'lock.d', 'pid')), `${process.pid}\n`, 'live lock kept');
      rmSync(join(p.state, 'lock.d'), { recursive: true });

      // The moved state dir left a symlink behind; a leftover flusher recreating the old
      // path would go through it. Simulate a real legacy dir appearing anyway.
      assert.ok(isLink(legacyState));
      rmSync(legacyState);

      // Both old and new exist: the new ones win, queued events moved, the rest set aside.
      mkdirSync(legacyConfigDir, { recursive: true });
      writeFileSync(join(legacyConfigDir, 'config'), "JFM_WRITE_TOKEN='old'\n");
      mkdirSync(join(legacyState, 'outbox'), { recursive: true });
      writeFileSync(join(legacyState, 'outbox', '1700000000000-2-b.json'), '{"queued":2}\n');
      writeFileSync(join(legacyState, 'emit.log'), 'old log\n');
      const r2 = await install(home);
      assert.equal(r2.code, 0, r2.stderr);
      assert.match(r2.stdout, /NOTE: both .*job-farm-mon and .*job-farm-monitor existed/);
      assert.match(r2.stdout, /may hold a write token/);
      assert.match(r2.stdout, /migrated: 1 queued event file/);
      assert.match(read(p.config), /^JFM_WRITE_TOKEN='t1'$/m);
      assert.equal(read(join(p.state, 'outbox', '1700000000000-2-b.json')), '{"queued":2}\n');
      const aside = (base) => readdirSync(join(base, '..')).filter((n) => n.startsWith('job-farm-mon.migrated-'));
      const [cfgAside] = aside(legacyConfigDir);
      const [stateAside] = aside(legacyState);
      assert.equal(read(join(home, '.config', cfgAside, 'config')), "JFM_WRITE_TOKEN='old'\n");
      assert.equal(read(join(home, '.local', 'state', stateAside, 'emit.log')), 'old log\n');
      assert.ok(isLink(legacyConfigDir) && isLink(legacyState));

      // The NOTE does not repeat on the next install.
      const r3 = await install(home);
      assert.equal(r3.code, 0, r3.stderr);
      assert.doesNotMatch(r3.stdout, /NOTE|migrated/);

      // Uninstall without --purge names the kept legacy dirs.
      const k = await install(home, ['--uninstall']);
      assert.equal(k.code, 0, k.stderr);
      assert.match(k.stdout, new RegExp(`kept config and state .*${cfgAside}.*${stateAside}`));

      // --purge also removes the leftover legacy directories.
      const u = await install(home, ['--uninstall', '--purge']);
      assert.equal(u.code, 0, u.stderr);
      for (const d of [p.config, p.state, legacyConfigDir, legacyState,
        join(home, '.config', cfgAside), join(home, '.local', 'state', stateAside)]) {
        assert.equal(existsSync(d) || isLink(d), false, d);
      }
    } finally {
      await cleanupHome(home);
    }
  });

  test('migration waits until all input is valid; --no-omp keeps the old extension working', async () => {
    const home = fixtureHome();
    const p = paths(home);
    const legacyConfigDir = join(home, '.config', 'job-farm-mon');
    const legacyExt = join(home, '.omp', 'agent', 'extensions', 'job-farm-mon.ts');
    const claudeBefore = read(p.claude);
    try {
      mkdirSync(legacyConfigDir, { recursive: true });
      writeFileSync(join(legacyConfigDir, 'config'), "JFM_ENDPOINT='https://x.dev'\nJFM_WRITE_TOKEN='old'\n");
      writeFileSync(legacyExt, '// old extension\n');

      const bad = await install(home, ['--token', 'a b']);
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /must not contain/);
      assert.doesNotMatch(bad.stdout, /migrated/);
      assert.ok(lstatSync(legacyConfigDir).isDirectory() && !isLink(legacyConfigDir), 'nothing moved');
      assert.equal(existsSync(p.config), false);

      writeFileSync(p.claude, '[1]');
      const notObj = await install(home);
      assert.equal(notObj.code, 1);
      assert.match(notObj.stderr, /not a JSON object/);
      assert.ok(!isLink(legacyConfigDir), 'nothing moved');
      assert.equal(existsSync(p.emit), false, 'jfm-emit not replaced');
      writeFileSync(p.claude, claudeBefore);

      const r = await install(home, ['--no-omp']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /old oh-my-pi extension .*job-farm-mon\.ts is still installed/);
      assert.ok(existsSync(legacyExt), '--no-omp respected');
      // The old extension still finds its config through the symlink.
      assert.match(read(join(legacyConfigDir, 'config')), /JFM_WRITE_TOKEN='old'/);
      assert.match(read(p.config), /JFM_WRITE_TOKEN='old'/);
    } finally {
      await cleanupHome(home);
    }
  });

  test('uninstall removes the old omp extension too', async () => {
    const home = fixtureHome();
    const p = paths(home);
    const legacyExt = join(home, '.omp', 'agent', 'extensions', 'job-farm-mon.ts');
    try {
      writeFileSync(legacyExt, '// old extension\n');
      const u = await install(home, ['--uninstall']);
      assert.equal(u.code, 0, u.stderr);
      assert.match(u.stdout, /removed: .*job-farm-mon\.ts/);
      assert.equal(existsSync(legacyExt), false);
      assert.equal(existsSync(p.ompExt), false);
      assert.ok(existsSync(p.herdrExt));

      writeFileSync(legacyExt, '// old extension\n');
      const keep = await install(home, ['--uninstall', '--no-omp']);
      assert.equal(keep.code, 0, keep.stderr);
      assert.ok(existsSync(legacyExt), '--no-omp respected');
    } finally {
      await cleanupHome(home);
    }
  });

  test('skips agents that are not installed and rejects bad input', async () => {
    const home = tempHome('jfm-install-');
    try {
      const r = await install(home, ['--endpoint', 'https://x.dev', '--token', 't']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /skipped Claude Code/);
      assert.match(r.stdout, /skipped Codex/);
      assert.equal(existsSync(join(home, '.claude')), false);

      const bad = await install(home, ['--token', "it's"]);
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /must not contain quotes/);

      const unknown = await install(home, ['--bogus']);
      assert.equal(unknown.code, 1);

      mkdirSync(join(home, '.claude'));
      writeFileSync(join(home, '.claude', 'settings.json'), '[1]');
      const notObj = await install(home, ['--no-codex']);
      assert.equal(notObj.code, 1);
      assert.match(notObj.stderr, /not a JSON object/);
      assert.equal(read(join(home, '.claude', 'settings.json')), '[1]', 'left untouched');
    } finally {
      await cleanupHome(home);
    }
  });
});
