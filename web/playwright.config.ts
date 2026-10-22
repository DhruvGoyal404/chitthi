import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Uploads in e2e runs go to a temporary folder: never the repo's .data, and never a nearly full
// drive (the API's disk guard would refuse them).
// CI sets E2E_MEDIA_DIR to a RAM-backed folder (/dev/shm), so a runner's nearly full disk can't
// trip the guard either; the guard's own behaviour is covered by the API tests.
const MEDIA_DIR = process.env.E2E_MEDIA_DIR ?? join(tmpdir(), 'chitthi-e2e-media');

const CI = Boolean(process.env.CI);

/**
 * End-to-end tests against the real stack: the API (Postgres via DATABASE_URL, dev sign-in on)
 * and the production web build served by `vite preview` with the same /api proxy as dev. Ports are
 * Chitthi's own (web 5175, API 8082); locally, already-running servers are reused.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5175',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    {
      command: 'node --env-file-if-exists=../.env --import tsx ../api/src/server.ts',
      url: 'http://127.0.0.1:8082/api/health',
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: { DEV_LOGIN: 'true', RATE_LIMIT_AUTH: '5000', LOG_LEVEL: 'warn', MEDIA_DIR },
    },
    {
      command: 'npm run build && npx vite preview',
      url: 'http://localhost:5175',
      reuseExistingServer: !CI,
      timeout: 180_000,
    },
  ],
});
