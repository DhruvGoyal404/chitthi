import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Locally, TEST_DATABASE_URL comes from the repo's .env (CI sets it in the workflow). Only that
// one key is read: the rest of .env (NODE_ENV, DEV_LOGIN, …) must not leak into the test process.
if (!process.env.TEST_DATABASE_URL && existsSync('../.env')) {
  const line = /^TEST_DATABASE_URL=(.+)$/m.exec(readFileSync('../.env', 'utf8'));
  if (line?.[1]) process.env.TEST_DATABASE_URL = line[1].trim();
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // DB tests open many connections (the concurrency tests use 25); one file at a time keeps
    // the 256 MB, max_connections=40 Postgres comfortable.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
