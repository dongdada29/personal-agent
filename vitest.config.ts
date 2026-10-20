import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'scripts/test/**/*.test.ts', 'apps/desktop/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: process.platform === 'win32' ? 60_000 : 15_000,
    hookTimeout: process.platform === 'win32' ? 60_000 : 15_000,
  },
});
