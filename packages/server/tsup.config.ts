import { defineConfig } from 'tsup';

// Bundles the Node (Railway) entry and the Vercel entry (loaded by ./index.js).
// @jfm/core is inlined from source: the Docker image does not need the core
// dist, and Vercel's file tracing drops the workspace symlink to @jfm/core.
// Real npm dependencies (hono, @hono/node-server, @libsql/client, zod) and node
// builtins (incl. node:sqlite) stay external.
export default defineConfig({
  entry: ['src/entry.node.ts', 'src/entry.vercel.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@jfm\/core/],
  external: ['node:sqlite'],
  // tsup strips `node:` by default; `sqlite` alone is not a module (node:sqlite is prefix-only).
  removeNodeProtocol: false,
  esbuildOptions(options) {
    options.conditions = ['@jfm/source'];
  },
});
