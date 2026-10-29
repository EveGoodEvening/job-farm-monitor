// Vercel entrypoint (Hono framework preset; Vercel Root Directory = packages/server).
//
// - @vercel/hono uses the first of app, index, server, src/app, src/index,
//   src/server (.js before .ts) whose text imports "hono". Without this file it
//   would pick src/app.ts, which has no default export.
// - It points at the tsup bundle (dist/entry.vercel.js, built by
//   `npm run build`) rather than src/: the bundle inlines @jfm/core, because
//   Vercel's file tracing drops the npm-workspace symlink node_modules/@jfm/core.
import 'hono'; // keep: the preset only accepts entry files that import "hono"

export { default } from './dist/entry.vercel.js';
