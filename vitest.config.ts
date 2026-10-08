import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
