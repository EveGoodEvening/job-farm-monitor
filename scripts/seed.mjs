#!/usr/bin/env node
// Seed a local job-farm-mon server with demo sessions built from the hook
// payload fixtures in packages/core/test/fixtures/{claude,codex,omp}/*.json.
//
//   JFM_WRITE_TOKEN=<token> npm run seed
//   JFM_ENDPOINT=http://127.0.0.1:8787 JFM_WRITE_TOKEN=tokA,tokB node scripts/seed.mjs [--dry-run]
//
// Env:
//   JFM_ENDPOINT     server origin (default http://127.0.0.1:8787); POSTs to /api/ingest
//   JFM_WRITE_TOKEN  write token; a comma-separated list spreads the demo
//                    sessions over several hosts (the host label comes from the token)
//   JFM_READ_TOKEN   optional; when set, the resulting /api/state is summarized
//
// Each scenario below is a sequence of fixture names; the script looks them up
// in the fixture directory of that agent, gives every scenario a fresh session
// id and project dir, wraps each raw payload into a v1 envelope (unique id,
// timestamps spread over the last ~30 minutes) and POSTs them in ts order.
// Steps whose fixture file does not exist are skipped, so the script keeps
// working while the fixture set changes; unreadable files are ignored.
//
// Note: events are back-dated, so the server marks cards whose last event is
// more than 60 s old as "delayed" (DELAYED_MS). That is expected for seed data.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../packages/core/test/fixtures/', import.meta.url));
const MIN = 60_000;
const BATCH = 100; // INGEST_MAX_BATCH

const endpoint = (process.env.JFM_ENDPOINT || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const tokens = (process.env.JFM_WRITE_TOKEN || '').split(',').map((s) => s.trim()).filter(Boolean);
const readToken = process.env.JFM_READ_TOKEN || '';
const dryRun = process.argv.includes('--dry-run');
if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log('usage: JFM_WRITE_TOKEN=<token[,token2]> [JFM_ENDPOINT=http://127.0.0.1:8787] node scripts/seed.mjs [--dry-run]');
  process.exit(0);
}
if (!dryRun && tokens.length === 0) {
  console.error('seed: JFM_WRITE_TOKEN is not set (use a token from the server\'s WRITE_TOKENS)');
  process.exit(2);
}

// --- fixtures ----------------------------------------------------------------

/** agent -> Map<basename without .json, payload object> */
function loadFixtures(agent) {
  const dir = join(FIXTURES, agent);
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) out.set(f.slice(0, -5), v);
    } catch {
      // ignore unreadable fixture
    }
  }
  return out;
}

/** Find a fixture: exact name, then `<name>.synthetic`, then any `<name>.<variant>`. */
function pick(fx, names) {
  for (const name of names) {
    if (fx.has(name)) return fx.get(name);
    if (fx.has(`${name}.synthetic`)) return fx.get(`${name}.synthetic`);
  }
  for (const name of names) {
    for (const [k, v] of fx) if (k.startsWith(`${name}.`) && !k.includes('invalid')) return v;
  }
  return null;
}

// --- scenarios ---------------------------------------------------------------
// A step is [fixture names (alternatives), patch?]; patch(payload, ctx) returns
// the fields to merge (tool_input is merged one level deep).
// `from`/`to` are minutes ago; steps are spread evenly between them.

const cmd = (command, description) => () => ({ tool_input: { command, ...(description ? { description } : {}) } });
const file = (rel) => (_p, c) => ({ tool_input: { file_path: `${c.cwd}/${rel}` } });
const prompt = (_p, c) => ({ prompt: c.title });

const SCENARIOS = [
  // ---- Claude Code
  { agent: 'claude', project: 'billing-api', title: 'Fix the flaky invoice rounding test', from: 29, to: 21, steps: [
    [['SessionStart']], [['UserPromptSubmit'], prompt],
    [['PreToolUse.Read'], file('src/invoice/round.ts')], [['PreToolUse.Bash'], cmd('npm test -- invoice', 'Run invoice tests')],
    [['Stop'], () => ({ last_assistant_message: 'Fixed: rounding now uses banker\'s rounding; 48 tests pass.' })],
    [['SessionEnd']],
  ] },
  { agent: 'claude', project: 'docs-site', title: 'Update the deployment guide for Railway', from: 26, to: 14, steps: [
    [['SessionStart']], [['UserPromptSubmit'], prompt],
    [['PreToolUse.Read'], file('content/deploy/railway.md')], [['PreToolUse.Bash'], cmd('npm run lint:md', 'Lint markdown')],
    [['PostToolUse.Bash']],
    [['Stop'], () => ({ last_assistant_message: 'Updated the Railway section (volume at /data, env vars, health check) and fixed two broken links. Markdown lint is clean. Want me to also add a screenshot of the Railway variables page?' })],
  ] },
  { agent: 'claude', project: 'infra', title: 'Rotate the staging TLS certificates', from: 9, to: 3, steps: [
    [['SessionStart']], [['UserPromptSubmit'], prompt],
    [['PreToolUse.Read'], file('terraform/staging/certs.tf')],
    [['PreToolUse.Bash'], cmd('terraform plan -target=module.certs', 'Plan cert rotation')],
    [['PermissionRequest'], () => ({ tool_name: 'Bash', tool_input: { command: 'terraform apply -target=module.certs', description: 'Apply cert rotation' } })],
  ] },
  { agent: 'claude', project: 'job-farm-mon', title: 'Add a host filter to the dashboard', from: 6, to: 0.2, steps: [
    [['SessionStart']], [['UserPromptSubmit'], prompt],
    [['PreToolUse.Agent'], () => ({ tool_input: { description: 'Find the host filter state' } })],
    [['SubagentStart']], [['PreToolUse.subagent'], file('packages/web/src/state.ts')],
    [['PreToolUse.Read'], file('packages/web/src/components/TopBar.tsx')],
    [['PreToolUse.Bash'], cmd('npx vitest run packages/web', 'Run web tests')],
  ] },
  // ---- Codex CLI
  { agent: 'codex', project: 'ml-pipeline', title: 'Which dataset split should the eval use?', from: 12, to: 2, steps: [
    [['SessionStart']], [['UserPromptSubmit'], prompt],
    [['PreToolUse.Bash'], cmd('python -m eval.list_splits')],
    [['PreToolUse.request_user_input_async', 'PreToolUse.request_user_input'],
      () => ({ tool_input: { questions: [{ title: 'Use the 2026-09 holdout split or the rolling window?', options: ['holdout', 'rolling'] }] } })],
  ] },
  { agent: 'codex', project: 'search-indexer', title: 'Reindex the product catalog', from: 24, to: 12, steps: [
    [['SessionStart']], [['UserPromptSubmit'], prompt],
    [['PreToolUse.Bash'], cmd('cargo build --release')],
    [['PreToolUse.spawn_agent'], () => ({ tool_input: { task_name: 'verify_index' } })],
    [['SubagentStart']], [['PreToolUse.subagent'], cmd('curl -s localhost:9200/_cat/indices')],
  ] },
  { agent: 'codex', project: 'mobile-app', title: 'Bump the iOS deployment target to 17', from: 18, to: 7, steps: [
    [['SessionStart.exec', 'SessionStart']], [['UserPromptSubmit'], prompt],
    [['PreToolUse.Bash'], cmd('rg -n IPHONEOS_DEPLOYMENT_TARGET ios/')],
    [['PostToolUse.Bash']],
    [['Stop'], () => ({ last_assistant_message: 'Deployment target is now 17.0 in the project and Podfile; pod install succeeded.' })],
  ] },
  { agent: 'codex', project: 'payments', title: 'Delete the stale feature branches', from: 4, to: 0.8, steps: [
    [['SessionStart']], [['UserPromptSubmit'], prompt],
    [['PreToolUse.Bash.before_permission', 'PreToolUse.Bash'], cmd('git branch -r --merged origin/main')],
    [['PermissionRequest'], () => ({ tool_input: { command: 'git push origin --delete feat/old-checkout', description: 'Delete a remote branch' } })],
  ] },
  // ---- oh-my-pi (payloads are already canonical events)
  { agent: 'omp', project: 'game-engine', title: 'Profile the physics step', from: 15, to: 0.5, steps: [
    [['session_start']], [['prompt'], (_p, c) => ({ text: c.title })],
    [['tool_start'], () => ({ tool: 'bash', summary: 'cargo bench physics' })],
    [['subagent_start']], [['tool_start.subagent'], () => ({ summary: 'src/physics/step.rs' })],
    [['tool_start'], () => ({ tool: 'edit', summary: 'src/physics/broadphase.rs' })],
  ] },
  { agent: 'omp', project: 'data-export', title: 'Export last month\'s orders to parquet', from: 20, to: 10, steps: [
    [['session_start']], [['prompt'], (_p, c) => ({ text: c.title })],
    [['tool_start'], () => ({ tool: 'bash', summary: 'python export.py --month 2026-09' })],
    [['error']],
  ] },
  { agent: 'omp', project: 'auth-service', title: 'Clean up the node_modules cache', from: 5, to: 1, steps: [
    [['session_start']], [['prompt'], (_p, c) => ({ text: c.title })],
    [['tool_start'], () => ({ tool: 'bash', summary: 'du -sh node_modules' })],
    [['blocked.permission']],
  ] },
  { agent: 'omp', project: 'website', title: 'Write release notes for 2.4', from: 28, to: 16, steps: [
    [['session_start']], [['prompt'], (_p, c) => ({ text: c.title })],
    [['tool_start'], () => ({ tool: 'read', summary: 'CHANGELOG.md' })],
    [['turn_done'], () => ({ text: 'Release notes for 2.4 drafted in docs/releases/2.4.md.' })],
    [['session_end']],
  ] },
];

// --- build envelopes ---------------------------------------------------------

function merge(base, patch) {
  const out = { ...base, ...patch };
  if (patch.tool_input && typeof base.tool_input === 'object' && base.tool_input) {
    out.tool_input = { ...base.tool_input, ...patch.tool_input };
  }
  return out;
}

const fixtures = { claude: loadFixtures('claude'), codex: loadFixtures('codex'), omp: loadFixtures('omp') };
const now = Date.now();
const runId = now.toString(36);
const host = osHostname();
const envelopes = [];
const summary = [];
let seq = 0;
let pane = 0;

SCENARIOS.forEach((sc, i) => {
  const fx = fixtures[sc.agent];
  const payloads = [];
  const ctx = { cwd: `/home/dev/work/${sc.project}`, title: sc.title };
  for (const [names, patch] of sc.steps) {
    const base = pick(fx, names);
    if (!base) continue;
    payloads.push(patch ? merge(base, patch(base, ctx)) : { ...base });
  }
  if (payloads.length === 0) {
    summary.push(`  skip ${sc.agent}/${sc.project}: no fixtures`);
    return;
  }
  const sessionId = sc.agent === 'omp' ? `omp-${randomUUID().slice(0, 13)}` : randomUUID();
  const env = sc.agent === 'omp' ? {} : { herdr_pane_id: `w${runId}:p${++pane}`, herdr_tab_id: `w${runId}:t1`, herdr_workspace_id: `w${runId}` };
  const from = now - sc.from * MIN;
  const to = now - sc.to * MIN;
  const step = payloads.length > 1 ? (to - from) / (payloads.length - 1) : 0;
  payloads.forEach((p, k) => {
    let payload;
    if (sc.agent === 'omp') {
      payload = { ...p, sessionId };
      if (payload.type === 'session_start') payload.cwd = ctx.cwd;
    } else {
      payload = { ...p, session_id: sessionId, cwd: ctx.cwd };
      if (typeof payload.transcript_path === 'string') payload.transcript_path = `/home/dev/.${sc.agent}/sessions/${sessionId}.jsonl`;
    }
    envelopes.push({
      tokenIdx: i % Math.max(tokens.length, 1),
      env: {
        v: 1,
        id: `seed-${runId}-${++seq}`,
        ts: Math.round(from + step * k),
        agent: sc.agent,
        hostname: host,
        pid: 40000 + i,
        ...(Object.keys(env).length ? { env } : {}),
        payload,
      },
    });
  });
  summary.push(`  ${sc.agent.padEnd(6)} ${sc.project.padEnd(15)} ${payloads.length}/${sc.steps.length} events  ${sc.from}m..${sc.to}m ago`);
});

envelopes.sort((a, b) => a.env.ts - b.env.ts);
console.log(`seed: ${envelopes.length} envelopes from ${FIXTURES}`);
console.log(summary.join('\n'));

if (dryRun) {
  console.log(JSON.stringify(envelopes.map((e) => e.env), null, 2));
  process.exit(0);
}

// --- send ----------------------------------------------------------------------

async function post(token, batch) {
  const res = await fetch(`${endpoint}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(batch),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${endpoint}/api/ingest -> HTTP ${res.status} ${text}`);
  return JSON.parse(text);
}

let accepted = 0;
let ignored = 0;
let revision = 0;
try {
  for (let t = 0; t < Math.max(tokens.length, 1); t++) {
    const mine = envelopes.filter((e) => e.tokenIdx === t).map((e) => e.env);
    for (let k = 0; k < mine.length; k += BATCH) {
      const r = await post(tokens[t], mine.slice(k, k + BATCH));
      accepted += r.accepted;
      ignored += r.ignored;
      revision = r.revision;
    }
  }
} catch (e) {
  console.error(`seed: ${e instanceof Error ? e.message : e}${e?.cause?.code ? ` (${e.cause.code})` : ''}; is the server running at ${endpoint}?`);
  process.exit(1);
}
console.log(`seed: accepted ${accepted}, ignored ${ignored}, revision ${revision} (${endpoint})`);

if (readToken) {
  const res = await fetch(`${endpoint}/api/state?ended=24h`, { headers: { authorization: `Bearer ${readToken}` } });
  if (res.ok) {
    const st = await res.json();
    const counts = {};
    for (const s of st.sessions) {
      const k = s.state === 'blocked' ? `blocked/${s.stateKind}` : s.state;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    console.log(`seed: state has ${st.sessions.length} sessions`, counts);
  } else {
    console.error(`seed: GET /api/state -> HTTP ${res.status}`);
  }
}
