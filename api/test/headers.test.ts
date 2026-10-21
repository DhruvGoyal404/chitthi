import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { captureLogger, testConfig, WEB_ORIGIN } from './helpers.js';

// No database: testConfig points at an unreachable one, so the OAuth start below fails with 500.
const config = testConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
const { logger } = captureLogger(config);
const pool = createPool(config.databaseUrl, logger);
const app = createApp({ config, logger, pool });
afterAll(async () => {
  await pool.end();
});

/** helmet's defaults, with the API's own CSP (it only ever answers JSON or redirects). */
function expectHardened(res: request.Response) {
  expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
  expect(res.headers).toMatchObject({
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'origin-agent-cluster': '?1',
    'x-dns-prefetch-control': 'off',
    'x-download-options': 'noopen',
    'x-permitted-cross-domain-policies': 'none',
    'x-xss-protection': '0',
  });
  expect(res.headers['strict-transport-security']).toMatch(/^max-age=\d+; includeSubDomains$/);
  expect(res.headers['x-powered-by']).toBeUndefined();
}

describe('security headers (helmet defaults) on every kind of response', () => {
  it('JSON', async () => {
    const res = await request(app).get('/api/auth/providers');
    expect(res.status).toBe(200);
    expectHardened(res);
  });
  it('errors: 404, 401, 400 and the Origin refusal', async () => {
    expectHardened(await request(app).get('/api/nowhere'));
    expectHardened(await request(app).get('/api/me'));
    expectHardened(await request(app).post('/api/health').set('Origin', WEB_ORIGIN).set('Content-Type', 'application/json').send('{bad'));
    expectHardened(await request(app).post('/api/auth/logout').set('Origin', 'https://evil.example'));
  });
  it('a server error (the OAuth start needs the database, which is unreachable here)', async () => {
    const res = await request(app).get('/api/auth/github/start');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
    expectHardened(res);
  });
});
