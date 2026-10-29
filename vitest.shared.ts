// Shared Vite/Vitest helpers for workspace packages.
//
// Tests and Vite dev servers resolve `@jfm/core` (and its subpaths) straight to
// TypeScript source so nothing needs `npm run build -w @jfm/core` first.
// TypeScript does the same through the `@jfm/source` custom export condition
// (see tsconfig.base.json `customConditions`); tsup/esbuild via `conditions`.

const coreSrc = decodeURIComponent(new URL('./packages/core/src/', import.meta.url).pathname);

export const coreSourceAlias = [
  { find: /^@jfm\/core$/, replacement: `${coreSrc}index.ts` },
  { find: /^@jfm\/core\/drivers\/node-sqlite$/, replacement: `${coreSrc}drivers/node-sqlite.ts` },
  { find: /^@jfm\/core\/drivers\/libsql$/, replacement: `${coreSrc}drivers/libsql.ts` },
];
