import { defineConfig, devices } from '@playwright/test';

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
      env: { DEV_LOGIN: 'true', RATE_LIMIT_AUTH: '5000', LOG_LEVEL: 'warn' },
    },
    {
      command: 'npm run build && npx vite preview',
      url: 'http://localhost:5175',
      reuseExistingServer: !CI,
      timeout: 180_000,
    },
  ],
});
