// Dashboard files served by the app itself (Node/Railway and Vercel entries).
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import type { AppEnv } from './app.js';

/** Serve `root` (packages/web/dist or a copy) with SPA fallback to index.html; /api/* is left to the API. */
export function serveWeb(app: Hono<AppEnv>, root: string): void {
  app.get('*', serveStatic({ root }));
  // SPA fallback: extensionless paths (client routes) get index.html.
  app.get('*', async (c, next) => {
    if (/\.[A-Za-z0-9]+$/.test(c.req.path)) return next();
    return serveStatic({ root, path: 'index.html' })(c, next);
  });
}
