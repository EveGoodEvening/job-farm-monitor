import { defineConfig } from 'vitest/config';
import { coreSourceAlias } from '../../vitest.shared.ts';

// Node-side tests (app.test.ts, auth.test.ts, vercel-entry.test.ts, ...).
// Worker tests run separately: `npm run test:workers` (vitest.workers.config.ts).
export default defineConfig({
  resolve: { alias: coreSourceAlias },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/worker*.test.ts', 'test/worker/**'],
    environment: 'node',
  },
});
