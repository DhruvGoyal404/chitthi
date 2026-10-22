import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Timing-sensitive tests (npm run test:perf): run on their own, in their own CI job, so the
// main gate stays deterministic on a busy machine. Same setup as the main suite (spread, not
// mergeConfig, which would concatenate the include lists).
export default defineConfig({
  test: { ...base.test, include: ['test/perf/**/*.perf.test.ts'], exclude: ['**/node_modules/**'], testTimeout: 120_000 },
});
