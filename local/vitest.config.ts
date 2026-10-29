import { defineConfig } from 'vitest/config';

// Vitest covers TypeScript tests (omp-extension.test.ts); shell/installer tests
// are `node --test` *.test.mjs files run by the package "test" script.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
