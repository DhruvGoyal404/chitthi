import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { captureLogger, DB_PASSWORD, UNREACHABLE_DB_URL, WEB_ORIGIN } from './helpers.js';

// Nothing development-only can be switched on in production: the config refuses it, the dev
// routes are not even registered, and the real process exits before it listens.
const MEDIA_DIR = join(tmpdir(), 'chitthi-prod-test-media');
const PROD = { NODE_ENV: 'production', DATABASE_URL: UNREACHABLE_DB_URL, MEDIA_DIR, WEB_ORIGINS: WEB_ORIGIN };

describe('production config refuses every development switch', () => {
  it('RATE_LIMIT_AUTH (raising the sign-in limit) is refused in production, allowed in development and test', () => {
    expect(() => loadConfig({ ...PROD, RATE_LIMIT_AUTH: '5000' })).toThrow(/RATE_LIMIT_AUTH/);
    expect(loadConfig({ ...PROD, NODE_ENV: 'development', RATE_LIMIT_AUTH: '5000' }).authLimitPoints).toBe(5000);
    expect(loadConfig({ ...PROD, NODE_ENV: 'test', RATE_LIMIT_AUTH: '5000' }).authLimitPoints).toBe(5000);
    expect(loadConfig(PROD).authLimitPoints).toBeUndefined();
  });

  it('DEV_LOGIN, the disk-guard overrides and the OAuth endpoint overrides are refused too', () => {
    for (const [key, value] of [['DEV_LOGIN', 'true'], ['MEDIA_MIN_FREE_PERCENT', '5'], ['MEDIA_MIN_FREE_BYTES', '1'], ['GOOGLE_TOKEN_URL', 'http://127.0.0.1:1/token']] as const) {
      expect(() => loadConfig({ ...PROD, [key]: value }), key).toThrow(new RegExp(key));
    }
    expect(loadConfig({ ...PROD, DEV_LOGIN: 'false' }).devLogin).toBe(false);
  });
});

describe('the production route table has no development routes', () => {
  const config = loadConfig(PROD);
  const { logger } = captureLogger(config);
  const pool = createPool(config.databaseUrl, logger);
  const app = createApp({ config, logger, pool });
  afterAll(async () => {
    await pool.end();
  });

  it('dev sign-in, the pending-signup stand-in and dev logout do not exist (404, with an allowed Origin)', async () => {
    for (const path of ['/api/dev/login', '/api/dev/pending-signup', '/api/dev/logout']) {
      const res = await request(app).post(path).set('Origin', WEB_ORIGIN).send({ handle: 'intruder', displayName: 'X' });
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
  });

  it('the sign-in page is told there is no dev sign-in', async () => {
    expect((await request(app).get('/api/auth/providers')).body).toMatchObject({ dev: false });
  });
});

describe('the real API process', () => {
  const apiDir = fileURLToPath(new URL('..', import.meta.url));

  /** Starts src/server.ts with env; resolves when it logs "api listening" (then stops it) or exits. */
  function start(env: Record<string, string>): Promise<{ code: number | null; listened: boolean; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        cwd: apiDir,
        env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'info', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let listened = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error(`no verdict within 30 s:\n${output}`)); }, 30_000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (!listened && output.includes('"msg":"api listening"')) {
          listened = true;
          child.kill();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, listened, output });
      });
    });
  }

  it('refuses to start with NODE_ENV=production and DEV_LOGIN=true, naming the key, never the database URL', async () => {
    const r = await start({ ...PROD, DEV_LOGIN: 'true' });
    expect(r.listened).toBe(false);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/DEV_LOGIN/);
    expect(r.output).not.toContain(DB_PASSWORD);
    expect(r.output).not.toContain(UNREACHABLE_DB_URL);
  }, 40_000);

  it('refuses to start with NODE_ENV=staging and DEV_LOGIN=true (only development and test may have it)', async () => {
    const r = await start({ ...PROD, NODE_ENV: 'staging', DEV_LOGIN: 'true' });
    expect(r.listened).toBe(false);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/NODE_ENV|DEV_LOGIN/);
    expect(r.output).not.toContain(DB_PASSWORD);
  }, 40_000);

  it('refuses to start with NODE_ENV=production and RATE_LIMIT_AUTH set', async () => {
    const r = await start({ ...PROD, RATE_LIMIT_AUTH: '5000' });
    expect(r.listened).toBe(false);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/RATE_LIMIT_AUTH/);
  }, 40_000);

  it('starts normally in production with DEV_LOGIN=false (and still never prints the database URL)', async () => {
    const r = await start({ ...PROD, DEV_LOGIN: 'false' });
    expect(r.listened).toBe(true);
    expect(r.output).not.toMatch(/dev login enabled/);
    expect(r.output).not.toContain(DB_PASSWORD);
    expect(r.output).not.toContain(UNREACHABLE_DB_URL);
  }, 40_000);
});
