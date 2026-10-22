import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Locally, the test database URLs come from the repo's .env (CI sets them in the workflow). Only
// those keys are read: the rest of .env (NODE_ENV, DEV_LOGIN, …) must not leak into the tests.
const TEST_KEYS = ['TEST_DATABASE_URL', 'TEST_API_DATABASE_URL'] as const;
if (existsSync('../.env')) {
  const env = readFileSync('../.env', 'utf8');
  for (const key of TEST_KEYS) {
    const line = new RegExp(`^${key}=(.+)$`, 'm').exec(env);
    if (!process.env[key] && line?.[1]) process.env[key] = line[1].trim();
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Timing-sensitive tests run separately: npm run test:perf (vitest.perf.config.ts).
    exclude: ['test/perf/**', '**/node_modules/**'],
    globalSetup: ['test/globalSetup.ts'],
    // DB tests open many connections (the concurrency tests use 25); one file at a time keeps
    // the 256 MB, max_connections=40 Postgres comfortable.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
