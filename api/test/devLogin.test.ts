import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { devLoginRouter } from '../src/devLogin.js';
import { createRateLimits } from '../src/limits.js';
import { hashSessionToken, SESSION_COOKIE, SessionStore } from '../src/sessions.js';
import { adminPool, appPool, uniqueHandle } from './dbhelpers.js';
import { captureLogger, testConfig, UNREACHABLE_DB_URL, WEB_ORIGIN } from './helpers.js';

const url = inject('dbUrl');
const apiUrl = inject('apiDbUrl');

describe('dev login guards (no database needed)', () => {
  it('is refused in production by both the config and the router', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: UNREACHABLE_DB_URL, DEV_LOGIN: 'true' })).toThrow(/DEV_LOGIN/);
    const pool = appPool(UNREACHABLE_DB_URL);
    expect(() => devLoginRouter('production', pool, new SessionStore(pool))).toThrow(/refused/);
    void pool.end();
  });
});

describe.skipIf(!url)('dev login and Postgres sessions', () => {
  const pool = appPool(apiUrl);
  const admin = adminPool(url);
  afterAll(async () => {
    await Promise.all([pool.end(), admin.end()]);
  });

  function setup(opts: { devLogin?: boolean; authPoints?: number } = {}) {
    const config = testConfig({ DATABASE_URL: apiUrl, DEV_LOGIN: String(opts.devLogin ?? true) });
    const { logger } = captureLogger(config);
    // A namespace per app keeps each test's rate-limit counters separate in the shared table.
    const namespace = `t${randomBytes(4).toString('hex')}:`;
    const rateLimits = createRateLimits(pool, logger, { auth: { points: opts.authPoints ?? 100, duration: 60 }, send: { points: 1000, duration: 60 }, socket: { points: 1000, duration: 60 } }, namespace);
    return createApp({ config, logger, pool, rateLimits });
  }

  const cookieOf = (res: request.Response): string => {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const c = raw?.find((v) => v.startsWith(`${SESSION_COOKIE}=`));
    if (!c) throw new Error('no session cookie');
    return c;
  };
  const pair = (cookie: string) => cookie.split(';')[0] ?? '';
  const tokenOf = (cookie: string) => decodeURIComponent(pair(cookie).split('=')[1] ?? '');
  const login = (app: ReturnType<typeof setup>, handle: string, cookie?: string) => {
    const r = request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN);
    if (cookie) r.set('Cookie', cookie);
    return r.send({ handle });
  };

  it('signs in, creates the user once, sets an HttpOnly SameSite=Lax cookie, and /api/me returns the user', async () => {
    const app = setup();
    const handle = uniqueHandle('Asha');
    const res = await login(app, `  ${handle} `);
    expect(res.status).toBe(201);
    expect(res.body.user.handle).toBe(handle);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await request(app).get('/api/me').set('Cookie', pair(cookie));
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(res.body.user);

    // Same handle in any case → same user (the dev identity is keyed by lower(handle)).
    const again = await login(app, handle.toUpperCase());
    expect(again.body.user.id).toBe(res.body.user.id);
  });

  it('stores only the SHA-256 of the token', async () => {
    const app = setup();
    const cookie = cookieOf(await login(app, uniqueHandle()));
    const token = tokenOf(cookie);
    expect(token.length).toBeGreaterThanOrEqual(43);
    const { rows } = await admin.query<{ row: string }>(
      'SELECT row_to_json(s)::text AS row FROM sessions s WHERE token_hash = $1', [hashSessionToken(token)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).not.toContain(token);
  });

  it('rotates on sign-in and revokes on logout', async () => {
    const app = setup();
    const handle = uniqueHandle();
    const first = pair(cookieOf(await login(app, handle)));
    const second = pair(cookieOf(await login(app, handle, first)));
    expect((await request(app).get('/api/me').set('Cookie', first)).status).toBe(401);
    expect((await request(app).get('/api/me').set('Cookie', second)).status).toBe(200);

    const out = await request(app).post('/api/dev/logout').set('Origin', WEB_ORIGIN).set('Cookie', second);
    expect(out.status).toBe(204);
    expect((await request(app).get('/api/me').set('Cookie', second)).status).toBe(401);
  });

  it('rejects expired sessions and sessions of disabled users', async () => {
    const app = setup();
    const expired = cookieOf(await login(app, uniqueHandle()));
    await admin.query(
      `UPDATE sessions SET created_at = now() - interval '10 days', expires_at = now() - interval '1 day' WHERE token_hash = $1`,
      [hashSessionToken(tokenOf(expired))],
    );
    expect((await request(app).get('/api/me').set('Cookie', pair(expired))).status).toBe(401);

    const res = await login(app, uniqueHandle());
    await admin.query('UPDATE users SET disabled_at = now() WHERE id = $1', [res.body.user.id]);
    expect((await request(app).get('/api/me').set('Cookie', pair(cookieOf(res)))).status).toBe(401);
  });

  it('revokeAll signs a user out everywhere', async () => {
    const app = setup();
    const handle = uniqueHandle();
    const a = await login(app, handle);
    const b = await login(app, handle);
    expect(await new SessionStore(pool).revokeAll(a.body.user.id as string)).toBe(2);
    for (const r of [a, b]) expect((await request(app).get('/api/me').set('Cookie', pair(cookieOf(r)))).status).toBe(401);
  });

  it('rejects reserved and taken handles, and validates format', async () => {
    const app = setup();
    const reserved = await login(app, 'Admin');
    expect(reserved.status).toBe(400);
    expect(reserved.body.error.code).toBe('handle_reserved');

    // A non-dev user owns the handle (any casing): the dev sign-in may not take it over.
    const taken = uniqueHandle('Ravi');
    await pool.query("INSERT INTO users (handle, display_name) VALUES ($1, 'Ravi')", [taken]);
    const clash = await login(app, taken.toLowerCase());
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('handle_taken');

    for (const handle of ['ab', 'has space', 'x'.repeat(21), '<script>', 42]) {
      const res = await login(app, handle as string);
      expect(res.status).toBe(400);
    }
  });

  it('requires an allowed Origin', async () => {
    const app = setup();
    expect((await request(app).post('/api/dev/login').send({ handle: uniqueHandle() })).status).toBe(403);
    expect((await request(app).post('/api/dev/login').set('Origin', 'http://localhost:5173').send({ handle: uniqueHandle() })).status).toBe(403);
  });

  it('is rate limited per IP, with counters in Postgres', async () => {
    const app = setup({ authPoints: 2 });
    expect((await login(app, uniqueHandle())).status).toBe(201);
    expect((await login(app, uniqueHandle())).status).toBe(201);
    const limited = await login(app, uniqueHandle());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM rate_limits WHERE key LIKE 't%:auth%'");
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it('is not mounted unless enabled', async () => {
    const app = setup({ devLogin: false });
    expect((await login(app, uniqueHandle())).status).toBe(404);
    expect((await request(app).get('/api/me')).status).toBe(401);
  });

  it('logs in as chitthi_api: a member of chitthi_app and nothing more', async () => {
    const { rows: [me] } = await pool.query<{ who: string; app: boolean; super: boolean; createdb: boolean; createrole: boolean; bypassrls: boolean; replication: boolean; roles: string[] }>(
      `SELECT current_user AS who, pg_has_role(current_user, 'chitthi_app', 'USAGE') AS app,
              r.rolsuper AS super, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolbypassrls AS bypassrls,
              r.rolreplication AS replication,
              ARRAY(SELECT b.rolname::text FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid) AS roles
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(me).toEqual({ who: 'chitthi_api', app: true, super: false, createdb: false, createrole: false, bypassrls: false, replication: false, roles: ['chitthi_app'] });
    await expect(pool.query('SET ROLE chitthi')).rejects.toThrow(/permission denied/);
    await expect(pool.query('CREATE TABLE nope (x int)')).rejects.toThrow(/permission denied/);
    await expect(pool.query("UPDATE conversations SET last_seq = 99")).rejects.toThrow(/permission denied/);
  });
});
