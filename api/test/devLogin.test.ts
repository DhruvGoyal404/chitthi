import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { devLoginRouter, devUserId } from '../src/devLogin.js';
import { createRateLimits } from '../src/limits.js';
import { MemorySessionStore, SESSION_COOKIE } from '../src/sessions.js';
import { captureLogger, testConfig, UNREACHABLE_DB_URL, WEB_ORIGIN } from './helpers.js';

const pools: { end: () => Promise<void> }[] = [];
function setup(opts: { devLogin?: boolean; authPoints?: number } = {}) {
  const config = testConfig({ DEV_LOGIN: String(opts.devLogin ?? true) });
  const { logger } = captureLogger(config);
  const pool = createPool(config.databaseUrl, logger);
  pools.push(pool);
  const sessions = new MemorySessionStore();
  const rateLimits = createRateLimits({ auth: { points: opts.authPoints ?? 100, duration: 60 } });
  return { app: createApp({ config, logger, pool, sessions, rateLimits }), sessions };
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

const cookieOf = (res: request.Response): string => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((v) => v.startsWith(`${SESSION_COOKIE}=`));
  if (!c) throw new Error('no session cookie');
  return c;
};

describe('dev login', () => {
  it('signs in, sets an HttpOnly SameSite=Lax cookie, and /api/me returns the user', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: '  Asha_1 ' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ user: { id: devUserId('asha_1'), handle: 'asha_1' } });
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await request(app).get('/api/me').set('Cookie', cookie.split(';')[0] ?? '');
    expect(me.status).toBe(200);
    expect(me.body.user.handle).toBe('asha_1');
  });

  it('stores only the token hash', async () => {
    const { app, sessions } = setup();
    const res = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: 'ravi' });
    const token = decodeURIComponent((cookieOf(res).split(';')[0] ?? '').split('=')[1] ?? '');
    expect(token.length).toBeGreaterThanOrEqual(43);
    const dump = JSON.stringify([...sessions.rows.entries()]);
    expect(dump).not.toContain(token);
    expect(sessions.rows.size).toBe(1);
  });

  it('rotates on sign-in and revokes on logout', async () => {
    const { app } = setup();
    const first = cookieOf(await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: 'meera' })).split(';')[0] ?? '';
    const second = cookieOf(
      await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).set('Cookie', first).send({ handle: 'meera' }),
    ).split(';')[0] ?? '';
    expect((await request(app).get('/api/me').set('Cookie', first)).status).toBe(401);
    expect((await request(app).get('/api/me').set('Cookie', second)).status).toBe(200);

    const out = await request(app).post('/api/dev/logout').set('Origin', WEB_ORIGIN).set('Cookie', second);
    expect(out.status).toBe(204);
    expect((await request(app).get('/api/me').set('Cookie', second)).status).toBe(401);
  });

  it('requires an allowed Origin', async () => {
    const { app } = setup();
    expect((await request(app).post('/api/dev/login').send({ handle: 'nobody' })).status).toBe(403);
    expect((await request(app).post('/api/dev/login').set('Origin', 'http://localhost:5173').send({ handle: 'nobody' })).status).toBe(403);
  });

  it('validates the handle', async () => {
    const { app } = setup();
    for (const handle of ['ab', 'has space', 'x'.repeat(21), '<script>', 42]) {
      const res = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
  });

  it('is rate limited per IP', async () => {
    const { app } = setup({ authPoints: 2 });
    const post = () => request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: 'spam' });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('is not mounted unless enabled', async () => {
    const { app } = setup({ devLogin: false });
    expect((await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: 'asha' })).status).toBe(404);
    expect((await request(app).get('/api/me')).status).toBe(401);
  });

  it('is refused in production by both the config and the router', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: UNREACHABLE_DB_URL, DEV_LOGIN: 'true' })).toThrow(/DEV_LOGIN/);
    expect(() => devLoginRouter('production', new MemorySessionStore())).toThrow(/refused/);
  });

  it('derives a stable, well-formed UUID per handle', () => {
    expect(devUserId('asha')).toBe(devUserId('asha'));
    expect(devUserId('asha')).not.toBe(devUserId('ravi'));
    expect(devUserId('asha')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('sessions', () => {
  it('expire', async () => {
    let now = new Date('2026-10-19T00:00:00Z');
    const store = new MemorySessionStore(() => now);
    const { token } = await store.create({ id: devUserId('a'), handle: 'a' }, undefined);
    expect(await store.find(token)).toBeDefined();
    now = new Date('2026-10-27T00:00:00Z');
    expect(await store.find(token)).toBeUndefined();
  });
});
