// Dev-only fake /api for working on the dashboard without a server:
//   JFM_MOCK=1 npm run dev -w @jfm/web
// Loaded only by vite.config.ts when JFM_MOCK=1 (configureServer), so none of
// this reaches the production bundle. Any token logs in.
import type { Plugin } from 'vite';
import type { SessionView, StateResponse } from '@jfm/core';

const MIN = 60_000;

function base(over: Partial<SessionView> & Pick<SessionView, 'host' | 'agent' | 'sessionId' | 'state'>): SessionView {
  const t = Date.now();
  return {
    key: `${over.host}/${over.agent}/${over.sessionId}`,
    cwd: `/root/github.com/acme/${over.project ?? 'repo'}`,
    project: 'repo',
    title: null,
    model: null,
    stateKind: null,
    stateMsg: null,
    stateSince: t - 2 * MIN,
    lastEventAt: t - 30_000,
    startedAt: t - 90 * MIN,
    endedAt: null,
    lastMessage: null,
    subagents: [],
    herdrPaneId: null,
    herdrTabId: null,
    herdrWorkspaceId: null,
    hostname: over.host,
    delayed: false,
    progress: [],
    ...over,
  };
}

function seed(): SessionView[] {
  const t = Date.now();
  return [
    base({
      host: 'kvm16188', agent: 'claude', sessionId: 'a1b2c3d4-1', state: 'blocked', stateKind: 'permission',
      project: 'job-farm-monitor', title: 'implement the web dashboard', stateMsg: 'Bash: rm -rf packages/web/dist && npm run build',
      stateSince: t - 4 * MIN, lastEventAt: t - 4 * MIN, herdrPaneId: 'w1:p3', model: 'claude-opus-5-5',
    }),
    base({
      host: 'macbook', agent: 'codex', sessionId: 'c0dex-77', state: 'blocked', stateKind: 'question',
      project: 'billing', title: '修复发票导出的时区问题', stateMsg: 'Should invoices use the customer timezone or UTC?',
      stateSince: t - 50_000, lastEventAt: t - 50_000,
    }),
    base({
      host: 'kvm16188', agent: 'omp', sessionId: 'omp-9', state: 'working', project: 'infra',
      title: 'migrate terraform state to the new bucket', lastEventAt: t - 25 * MIN,
      progress: [
        { ts: t - 25 * MIN, text: 'bash: terraform plan -out tf.plan', agentType: null },
        { ts: t - 26 * MIN, text: 'read: modules/s3/main.tf', agentType: null },
      ],
    }),
    base({
      host: 'kvm16188', agent: 'claude', sessionId: 'w2', state: 'working', project: 'job-farm-monitor',
      title: 'write store tests for libsql driver', lastEventAt: t - 6_000,
      subagents: [{ id: 'sa1', type: 'Explore', since: t - MIN }, { id: 'sa2', type: 'Plan', since: t - 30_000 }],
      progress: [
        { ts: t - 6_000, text: '[Explore] Grep: writeTx\\(', agentType: 'Explore' },
        { ts: t - 20_000, text: 'Bash: npx vitest run packages/core/test/store.test.ts', agentType: null },
        { ts: t - 70_000, text: 'Edit: packages/core/src/store.ts', agentType: null },
        { ts: t - 3 * MIN, text: 'Read: packages/core/src/drivers/libsql.ts', agentType: null },
      ],
    }),
    base({
      host: 'macbook', agent: 'claude', sessionId: 'd1', state: 'done', project: 'notes', title: 'summarise the meeting notes',
      lastEventAt: t - 8 * MIN, delayed: true,
      lastMessage: 'Done. I grouped the notes into three decisions and five follow-ups, and moved the open questions to the end of the file so they are easy to find next week.',
    }),
    base({
      host: 'kvm16188', agent: 'codex', sessionId: 'e1', state: 'error', project: 'scraper', title: 'add retry to fetcher',
      lastEventAt: t - 12 * MIN, stateMsg: 'API error: 529 overloaded', lastMessage: 'API error: 529 overloaded',
    }),
    base({ host: 'macbook', agent: 'omp', sessionId: 'i1', state: 'idle', project: 'dotfiles', lastEventAt: t - 40 * MIN }),
    // Silent for > INACTIVE_MS (6 h): rendered dimmed with the "possibly exited" flag.
    base({
      host: 'kvm16188', agent: 'codex', sessionId: 'z1', state: 'done', project: 'billing', title: 'bump invoice template',
      lastEventAt: t - 9 * 60 * MIN, lastMessage: 'Template bumped and snapshot tests updated.',
    }),
    base({
      host: 'kvm16188', agent: 'claude', sessionId: 'x1', state: 'ended', project: 'website', title: 'fix footer links',
      lastEventAt: t - 20 * MIN, endedAt: t - 20 * MIN, lastMessage: 'Footer links fixed.',
    }),
  ];
}

export function mockApi(): Plugin {
  const sessions = seed();
  let revision = 1;
  // Advance one working session every 5 s so polling shows movement.
  setInterval(() => {
    const s = sessions.find((x) => x.sessionId === 'w2');
    if (!s) return;
    const t = Date.now();
    s.progress = [{ ts: t, text: `Bash: npm test  # run ${revision}`, agentType: null }, ...s.progress].slice(0, 10);
    s.lastEventAt = t;
    revision++;
  }, 5_000).unref();

  return {
    name: 'jfm-mock-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (!url.pathname.startsWith('/api/')) return next();
        const json = (code: number, body?: unknown) => {
          res.statusCode = code;
          res.setHeader('cache-control', 'no-store');
          if (body === undefined) return res.end();
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (['/api/me', '/api/login', '/api/logout'].includes(url.pathname)) return json(204);
        if (url.pathname === '/api/state') {
          if (url.searchParams.get('since') === String(revision)) return json(304);
          const window = url.searchParams.get('ended') === '24h' ? 24 * 60 * MIN : 60 * MIN;
          const now = Date.now();
          const list = sessions
            .filter((s) => s.state !== 'ended' || (s.endedAt ?? 0) > now - window)
            .map((s) => ({ ...s, progress: s.progress.slice(0, 4) }))
            .sort((a, b) => b.lastEventAt - a.lastEventAt);
          const body: StateResponse = { revision, now, sessions: list };
          return json(200, body);
        }
        const m = /^\/api\/sessions\/(.+)$/.exec(url.pathname);
        if (m?.[1]) {
          const s = sessions.find((x) => x.key === decodeURIComponent(m[1] ?? ''));
          return s ? json(200, s) : json(404, { error: 'not_found' });
        }
        return json(404, { error: 'not_found' });
      });
    },
  };
}
