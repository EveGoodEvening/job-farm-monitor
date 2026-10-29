import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { coreSourceAlias } from '../../vitest.shared.ts';
import { READ_TOKEN, WRITE_TOKENS } from './test/tokens.ts';

// Runs test/worker*.test.ts inside workerd against wrangler.jsonc (DO SQLite).
// Heavy (spawns workerd): run via
//   ~/.claude/bin/heavy-gate -n 1 -l workers -- npm run test:workers
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { READ_TOKEN, WRITE_TOKENS } },
    }),
  ],
  resolve: { alias: coreSourceAlias },
  test: {
    include: ['test/worker*.test.ts', 'test/worker/**/*.test.ts'],
  },
});
