import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import { coreSourceAlias } from '../../vitest.shared.ts';
import { mockApi } from './dev/mock-api.ts';

// The web app imports only types + constants from `@jfm/core`. Pointing the
// bare specifier at constants.ts keeps zod / normalizers / Store (pulled in by
// core's index.ts barrel, whose module-level zod schemas are not tree-shaken)
// out of the bundle: ~40 KB gzip -> ~13 KB. Types still come from index.ts via
// tsc's `@jfm/source` condition, so a missing runtime export fails the build.
const coreConstants = decodeURIComponent(new URL('../core/src/constants.ts', import.meta.url).pathname);

// Dev: `npm run dev:web` proxies /api to the local server (entry.node.ts / wrangler dev, port 8787).
// `JFM_MOCK=1 npm run dev -w @jfm/web` serves a fake /api from dev/mock-api.ts instead
// (dev server only; never part of the build).
const useMock = process.env.JFM_MOCK === '1';

export default defineConfig({
  plugins: [preact(), ...(useMock ? [mockApi()] : [])],
  resolve: { alias: [{ find: /^@jfm\/core$/, replacement: coreConstants }, ...coreSourceAlias] },
  server: {
    proxy: useMock ? undefined : { '/api': 'http://127.0.0.1:8787' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
