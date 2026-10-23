import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// End-to-end runs never touch development data: the API runs against its own database,
// chitthi_e2e (dropped, recreated and migrated by api/scripts/e2e-db.ts before every run, which
// refuses any database whose name doesn't end in _e2e or _test), and its own media folder
// (emptied before the run, deleted after it by e2e/global-teardown.ts).
const E2E_DATABASE = 'chitthi_e2e';

/** A key from the environment (CI), else from the repo's .env (local runs). */
function setting(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  if (!existsSync('../.env')) return undefined;
  const line = new RegExp(`^${key}=(.+)$`, 'm').exec(readFileSync('../.env', 'utf8'));
  return line?.[1]?.trim();
}
/** The same server and credentials, the e2e database instead. */
function onE2eDatabase(url: string | undefined): string {
  if (!url) return '';
  const u = new URL(url);
  u.pathname = `/${E2E_DATABASE}`;
  return u.toString();
}

// Uploads in e2e runs go to a temporary folder: never the repo's .data, and never a nearly full
// drive (the API's disk guard would refuse them).
// CI sets E2E_MEDIA_DIR to a RAM-backed folder (/dev/shm), so a runner's nearly full disk can't
// trip the guard either; the guard's own behaviour is covered by the API tests.
export const MEDIA_DIR = process.env.E2E_MEDIA_DIR ?? join(tmpdir(), 'chitthi-e2e-media');

const CI = Boolean(process.env.CI);

/**
 * End-to-end tests against the real stack: the API (Postgres via DATABASE_URL, dev sign-in on)
 * and the production web build served by `vite preview` with the same /api proxy as dev. Ports are
 * Chitthi's own (web 5175, API 8082). Running servers are never reused: a dev API on 8082 would be
 * connected to the dev database, so if the dev stack is up, e2e fails on the busy port instead.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalTeardown: './e2e/global-teardown.ts',
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
      // First a fresh e2e database and media folder (refuses anything that isn't disposable), then the API.
      command: 'node --env-file-if-exists=../.env --import tsx ../api/scripts/e2e-db.ts && node --env-file-if-exists=../.env --import tsx ../api/src/server.ts',
      url: 'http://127.0.0.1:8082/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DEV_LOGIN: 'true', RATE_LIMIT_AUTH: '5000', LOG_LEVEL: 'warn', MEDIA_DIR,
        // Explicit values win over ../.env (Node's --env-file never overrides the environment).
        DATABASE_URL: onE2eDatabase(setting('DATABASE_URL')),
        E2E_ADMIN_DATABASE_URL: onE2eDatabase(setting('MIGRATION_DATABASE_URL')),
      },
    },
    {
      command: 'npm run build && npx vite preview',
      url: 'http://localhost:5175',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
