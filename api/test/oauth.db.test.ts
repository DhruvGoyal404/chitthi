import { randomBytes, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, secretsOf } from '../src/config.js';
import { createRateLimits } from '../src/limits.js';
import { FLOW_COOKIE, SIGNUP_COOKIE } from '../src/oauth/router.js';
import { SESSION_COOKIE } from '../src/sessions.js';
import { GENEROUS, signIn } from './apphelpers.js';
import { adminPool, appPool } from './dbhelpers.js';
import { captureLogger, testConfig, UNREACHABLE_DB_URL, WEB_ORIGIN } from './helpers.js';
import { mockGithub, mockGoogle } from './mockProviders.js';

const apiUrl = inject('apiDbUrl');
const ownerUrl = inject('dbUrl');
const GOOGLE_ID = 'google-client.apps.example';
/** Stands in for the providers' avatar servers (no network in tests): a PNG, and the URLs asked for. */
const fetched: string[] = [];
const fetchAvatar = async (url: URL): Promise<Buffer> => {
  fetched.push(url.href);
  return sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
};

type Cookies = Record<string, string>;
const cookiesOf = (res: request.Response): Cookies => {
  const out: Cookies = {};
  for (const c of (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []) {
    const [pair] = c.split(';');
    const [k, ...v] = (pair ?? '').split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
};
const cookieHeader = (c: Cookies) => Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');

describe('config for real sign-in', () => {
  const base = { NODE_ENV: 'production', DATABASE_URL: UNREACHABLE_DB_URL, MEDIA_DIR: '/var/lib/chitthi/media' };
  it('refuses test endpoint overrides in production, half-configured providers, and a foreign PUBLIC_ORIGIN', () => {
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', GOOGLE_TOKEN_URL: 'http://evil.example/token' })).toThrow(/GOOGLE_TOKEN_URL/);
    expect(() => loadConfig({ ...base, GITHUB_CLIENT_ID: 'x' })).toThrow(/GITHUB_CLIENT_SECRET/);
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'https://chitthi.example' })).toThrow(/PUBLIC_ORIGIN/);
    const ok = loadConfig({ ...base, WEB_ORIGINS: 'https://chitthi.example', PUBLIC_ORIGIN: 'https://chitthi.example/', TRUST_PROXY: '1' });
    expect(ok).toMatchObject({ publicOrigin: 'https://chitthi.example', trustProxy: true, google: undefined, github: undefined });
  });
  it('treats client secrets as secrets for log scrubbing', () => {
    const c = loadConfig({ ...base, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'gsecret-123456', GITHUB_CLIENT_ID: 'id2', GITHUB_CLIENT_SECRET: 'hsecret-654321' });
    expect(secretsOf(c)).toEqual(expect.arrayContaining(['gsecret-123456', 'hsecret-654321']));
  });
});

describe.skipIf(!apiUrl)('Google OIDC and GitHub OAuth (mock providers)', () => {
  const pool = appPool(apiUrl);
  const admin = adminPool(ownerUrl);
  let google: Awaited<ReturnType<typeof mockGoogle>>;
  let github: Awaited<ReturnType<typeof mockGithub>>;
  let app: Express;

  beforeAll(async () => {
    google = await mockGoogle(GOOGLE_ID);
    github = await mockGithub();
    const config = testConfig({
      DATABASE_URL: apiUrl, DEV_LOGIN: 'true',
      GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_CLIENT_SECRET: 'g-secret',
      GOOGLE_ISSUER: google.url, GOOGLE_AUTH_URL: `${google.url}/auth`, GOOGLE_TOKEN_URL: `${google.url}/token`, GOOGLE_JWKS_URL: `${google.url}/jwks`,
      GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret',
      GITHUB_AUTH_URL: `${github.url}/auth`, GITHUB_TOKEN_URL: `${github.url}/token`, GITHUB_API_URL: github.url,
    });
    const { logger } = captureLogger(config);
    app = createApp({ config, logger, pool, rateLimits: createRateLimits(pool, logger, GENEROUS, `t${randomBytes(4).toString('hex')}:`), fetchAvatar });
  });
  afterAll(async () => {
    await Promise.all([google.close(), github.close(), pool.end(), admin.end()]);
  });

  /** Starts a flow like a browser would; returns the authorize URL and this browser's cookies. */
  async function start(provider: 'google' | 'github', extra: Cookies = {}, path = 'start') {
    const res = await request(app).get(`/api/auth/${provider}/${path}?next=/c/x`).set('Cookie', cookieHeader(extra));
    expect(res.status).toBe(302);
    const location = String(res.headers.location);
    (provider === 'google' ? google : github).expectFlow(location);
    const u = new URL(location);
    return { location: u, state: u.searchParams.get('state') ?? '', cookies: { ...extra, ...cookiesOf(res) } };
  }
  const callback = (provider: string, query: Record<string, string>, cookies: Cookies) =>
    request(app).get(`/api/auth/${provider}/callback?${new URLSearchParams(query).toString()}`).set('Cookie', cookieHeader(cookies));
  const fresh = () => {
    google.state.subject = randomUUID();
    google.state.email = `g_${randomBytes(4).toString('hex')}@example.com`;
    google.state.scenario = {};
    github.state.id = Math.floor(Math.random() * 1e9);
    github.state.email = `h_${randomBytes(4).toString('hex')}@example.com`;
    github.state.scenario = {};
  };

  it('lists the configured providers', async () => {
    expect((await request(app).get('/api/auth/providers')).body).toEqual({ google: true, github: true, dev: true });
  });

  it('Google: code + PKCE S256 + state + nonce; a new identity becomes a pending signup, not a user', async () => {
    fresh();
    const { location, state, cookies } = await start('google');
    expect(location.origin + location.pathname).toBe(`${google.url}/auth`);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: GOOGLE_ID, response_type: 'code', scope: 'openid email profile', code_challenge_method: 'S256',
      redirect_uri: 'http://localhost:5175/api/auth/google/callback',
    });
    expect(location.searchParams.get('nonce')).toMatch(/^[\w-]{32}$/);
    expect(cookies[FLOW_COOKIE]).toBe(state);

    const res = await callback('google', { state, code: 'abc' }, cookies);
    expect(google.state.lastVerifierOk).toBe(true); // the API sent the verifier matching its challenge
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/welcome');
    const signup = cookiesOf(res)[SIGNUP_COOKIE];
    expect(signup).toMatch(/^[\w-]{43}$/);
    expect(cookiesOf(res)[SESSION_COOKIE]).toBeUndefined();
    const { rows } = await pool.query('SELECT 1 FROM identities WHERE provider = $1 AND subject = $2', ['google', google.state.subject]);
    expect(rows).toHaveLength(0); // no account until onboarding
  });

  const rejectsGoogle = async (scenario: Parameters<typeof Object.assign>[1], code: string) => {
    fresh();
    google.state.scenario = scenario as never;
    const { state, cookies } = await start('google');
    const res = await callback('google', { state, code: 'abc' }, cookies);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/signin?error=${code}&provider=google`);
    expect(cookiesOf(res)[SESSION_COOKIE]).toBeUndefined();
    expect(cookiesOf(res)[SIGNUP_COOKIE]).toBeUndefined();
  };
  it('Google: rejects a bad signature', () => rejectsGoogle({ foreignKey: true }, 'invalid_id_token'));
  it('Google: rejects the wrong audience', () => rejectsGoogle({ claims: { aud: 'someone-else' } }, 'invalid_id_token'));
  it('Google: rejects the wrong issuer', () => rejectsGoogle({ claims: { iss: 'https://evil.example' } }, 'invalid_id_token'));
  it('Google: rejects an expired token', () => rejectsGoogle({ claims: { exp: Math.floor(Date.now() / 1000) - 120, iat: Math.floor(Date.now() / 1000) - 600 } }, 'invalid_id_token'));
  it('Google: rejects a nonce mismatch', () => rejectsGoogle({ claims: { nonce: 'replayed-nonce' } }, 'invalid_id_token'));
  it('Google: rejects an unverified email', () => rejectsGoogle({ claims: { email_verified: false } }, 'email_unverified'));
  it('Google: a failed token exchange is reported, not thrown', () => rejectsGoogle({ tokenStatus: 500 }, 'token_exchange_failed'));
  it('Google: rejects an unsigned token (alg none)', () => rejectsGoogle({ forge: 'none' }, 'invalid_id_token'));
  it('Google: rejects HS256 keyed with the client secret (algorithm confusion)', () => rejectsGoogle({ forge: 'hs256' }, 'invalid_id_token'));
  it('Google: rejects a token without a nonce', () => rejectsGoogle({ claims: { nonce: undefined } }, 'invalid_id_token'));
  it('Google: rejects a token without email_verified', () => rejectsGoogle({ claims: { email_verified: undefined } }, 'email_unverified'));
  it('Google: rejects a token issued in the future', () => rejectsGoogle({ claims: { iat: Math.floor(Date.now() / 1000) + 600, exp: Math.floor(Date.now() / 1000) + 900 } }, 'invalid_id_token'));

  it('Google: tolerates up to a minute of clock skew on iat', async () => {
    fresh();
    google.state.scenario = { claims: { iat: Math.floor(Date.now() / 1000) + 45 } };
    const { state, cookies } = await start('google');
    expect((await callback('google', { state, code: 'abc' }, cookies)).headers.location).toBe('/welcome');
  });
  it('Google: rejects a token issued more than an hour ago, even if exp says otherwise', () => rejectsGoogle({ claims: { iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) + 300 } }, 'invalid_id_token'));

  it('an expired flow is refused like a replayed one', async () => {
    fresh();
    const { state, cookies } = await start('google');
    await admin.query("UPDATE oauth_flows SET expires_at = now() - interval '1 second' WHERE state_hash = sha256(convert_to($1, 'UTF8'))", [state]);
    expect((await callback('google', { state, code: 'abc' }, cookies)).headers.location).toBe('/signin?error=state_invalid&provider=google');
  });

  it('?next= can never leave the app', async () => {
    fresh();
    const existing = await signIn(app, 'nxt');
    await pool.query("INSERT INTO identities (user_id, provider, subject, email, email_verified) VALUES ($1, 'google', $2, $3, true)", [existing.id, google.state.subject, google.state.email]);
    for (const next of ['//evil.example/x', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '/c/ok']) {
      const res = await request(app).get(`/api/auth/google/start?next=${encodeURIComponent(next)}`);
      google.expectFlow(String(res.headers.location));
      const state = new URL(String(res.headers.location)).searchParams.get('state') ?? '';
      const done = await callback('google', { state, code: 'abc' }, cookiesOf(res));
      expect(done.headers.location, next).toBe(next === '/c/ok' ? '/c/ok' : '/');
    }
  });

  it('a pending signup expires after 30 minutes', async () => {
    fresh();
    const { state, cookies } = await start('google');
    const signup = cookiesOf(await callback('google', { state, code: 'abc' }, cookies))[SIGNUP_COOKIE] ?? '';
    await admin.query("UPDATE pending_signups SET expires_at = now() - interval '1 second' WHERE token_hash = sha256(convert_to($1, 'UTF8'))", [signup]);
    const res = await request(app).get('/api/auth/onboarding').set('Cookie', `${SIGNUP_COOKIE}=${signup}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('signup_expired');
  });

  it('GitHub: state + PKCE, verified primary email; a new identity becomes a pending signup', async () => {
    fresh();
    const { location, state, cookies } = await start('github');
    expect(Object.fromEntries(location.searchParams)).toMatchObject({ client_id: 'gh-id', scope: 'read:user user:email', code_challenge_method: 'S256' });
    const res = await callback('github', { state, code: 'abc' }, cookies);
    expect(github.state.lastVerifierOk).toBe(true);
    expect(res.headers.location).toBe('/welcome');
  });

  it('GitHub: refuses an account with no verified primary email', async () => {
    fresh();
    github.state.scenario = { emails: [{ email: 'x@example.com', primary: true, verified: false }, { email: 'y@example.com', primary: false, verified: true }] };
    const { state, cookies } = await start('github');
    expect((await callback('github', { state, code: 'abc' }, cookies)).headers.location).toBe('/signin?error=email_unverified&provider=github');
  });

  it('GitHub: a failed token exchange or user lookup is reported, not thrown', async () => {
    for (const scenario of [{ tokenStatus: 401 }, { userStatus: 502 }]) {
      fresh();
      github.state.scenario = scenario;
      const { state, cookies } = await start('github');
      const res = await callback('github', { state, code: 'abc' }, cookies);
      expect(res.headers.location, JSON.stringify(scenario)).toBe('/signin?error=token_exchange_failed&provider=github');
      expect(cookiesOf(res)[SESSION_COOKIE]).toBeUndefined();
    }
  });

  it('refuses a replayed state, a missing state, a state from another browser, and a cancelled consent', async () => {
    fresh();
    const { state, cookies } = await start('google');
    expect((await callback('google', { state, code: 'abc' }, cookies)).headers.location).toBe('/welcome');
    expect((await callback('google', { state, code: 'abc' }, cookies)).headers.location).toBe('/signin?error=state_invalid&provider=google');
    expect((await callback('google', { code: 'abc' }, cookies)).headers.location).toBe('/signin?error=state_mismatch&provider=google');
    const other = await start('google');
    expect((await callback('google', { state: other.state, code: 'abc' }, {})).headers.location).toBe('/signin?error=state_mismatch&provider=google');
    expect((await callback('google', { state: other.state, code: 'abc' }, cookies)).headers.location).toBe('/signin?error=state_mismatch&provider=google');
    expect((await callback('google', { error: 'access_denied', state: other.state }, other.cookies)).headers.location).toBe('/signin?error=cancelled&provider=google');
  });

  it('signs a known identity in, rotating the session, and never auto-links by email', async () => {
    fresh();
    const existing = await signIn(app, 'own');
    await pool.query("INSERT INTO identities (user_id, provider, subject, email, email_verified) VALUES ($1, 'google', $2, $3, true)", [existing.id, google.state.subject, google.state.email]);
    const { state, cookies } = await start('google', { [SESSION_COOKIE]: existing.cookie.split('=')[1] ?? '' });
    const res = await callback('google', { state, code: 'abc' }, cookies);
    expect(res.headers.location).toBe('/c/x'); // the ?next= it started with
    const rotated = cookiesOf(res)[SESSION_COOKIE];
    expect(rotated).toBeTruthy();
    expect(`${SESSION_COOKIE}=${rotated ?? ''}`).not.toBe(existing.cookie);
    expect((await request(app).get('/api/me').set('Cookie', existing.cookie)).status).toBe(401); // the old one is revoked
    expect((await request(app).get('/api/me').set('Cookie', `${SESSION_COOKIE}=${rotated ?? ''}`)).body.user.id).toBe(existing.id);

    // A GitHub identity with the SAME email but no link: refused, not merged.
    github.state.email = google.state.email.toUpperCase();
    const gh = await start('github');
    expect((await callback('github', { state: gh.state, code: 'abc' }, gh.cookies)).headers.location).toBe('/signin?error=account_exists&provider=github');
  });

  it('links explicitly from a signed-in session, with the linking rules', async () => {
    fresh();
    const me = await signIn(app, 'lnk');
    const session = { [SESSION_COOKIE]: me.cookie.split('=')[1] ?? '' };
    const link = async (provider: 'google' | 'github', s: Cookies = session) => {
      const f = await start(provider, s, 'link');
      return (await callback(provider, { state: f.state, code: 'abc' }, f.cookies)).headers.location as string;
    };
    expect(await link('github')).toBe('/account?linked=github');
    const ids = await request(app).get('/api/auth/identities').set('Cookie', me.cookie);
    expect(ids.body.identities.map((i: { provider: string; email: string }) => [i.provider, i.email])).toEqual([['github', github.state.email]]);
    expect(await link('github')).toBe('/account?linked=github'); // same identity again: already linked

    github.state.id += 1; // a different GitHub account
    expect(await link('github')).toBe('/account?error=provider_already_linked&provider=github');

    const other = await signIn(app, 'oth');
    await pool.query("INSERT INTO identities (user_id, provider, subject, email, email_verified) VALUES ($1, 'google', $2, $3, true)", [other.id, google.state.subject, google.state.email]);
    expect(await link('google')).toBe('/account?error=identity_in_use&provider=google');

    // Started while signed in as one user, finished as another: refused.
    google.state.subject = randomUUID();
    const f = await start('google', session, 'link');
    const third = await signIn(app, 'thr');
    const res = await callback('google', { state: f.state, code: 'abc' }, { ...f.cookies, [SESSION_COOKIE]: third.cookie.split('=')[1] ?? '' });
    expect(res.headers.location).toBe('/account?error=link_session_changed&provider=google');
    expect((await request(app).get('/api/auth/google/link')).status).toBe(401);
  });

  describe('first sign-in onboarding', () => {
    /** A Google first sign-in up to the welcome page; returns the signup cookie. */
    async function pending() {
      fresh();
      const { state, cookies } = await start('google');
      const res = await callback('google', { state, code: 'abc' }, cookies);
      return { [SIGNUP_COOKIE]: cookiesOf(res)[SIGNUP_COOKIE] ?? '' };
    }
    const finish = (cookies: Cookies, body: object) =>
      request(app).post('/api/auth/onboarding').set('Origin', WEB_ORIGIN).set('Cookie', cookieHeader(cookies)).send(body);

    it('prefills from the provider, then creates the account, its identity and a session in one go', async () => {
      const signup = await pending();
      const info = await request(app).get('/api/auth/onboarding').set('Cookie', cookieHeader(signup));
      expect(info.status).toBe(200);
      expect(info.body).toMatchObject({ provider: 'google', email: google.state.email, displayName: 'Asha Rao' });
      expect(info.body).not.toHaveProperty('avatarUrl'); // the provider's address never reaches the browser
      expect(info.body.suggestedHandle).toMatch(/^g_[0-9a-f]{8}$/); // the email's local part, free and not reserved

      // A reserved or taken handle is refused and the signup stays usable.
      expect((await finish(signup, { handle: 'Admin', displayName: 'Asha' })).body.error.code).toBe('handle_reserved');
      const taken = await signIn(app, 'tkn');
      expect((await finish(signup, { handle: taken.handle.toUpperCase(), displayName: 'Asha' })).body.error.code).toBe('handle_taken');
      expect((await finish(signup, { handle: 'x', displayName: 'Asha' })).status).toBe(400);

      const handle = `asha_${randomBytes(3).toString('hex')}`;
      const done = await finish({ ...signup, [SESSION_COOKIE]: 'planted-token' }, { handle, displayName: ' Asha R ' });
      expect(done.status).toBe(201);
      // Our copy, made from the provider's picture (asked for at 256 px) before the answer.
      const ours = new RegExp(`^/api/users/${String(done.body.user.id)}/avatar\\?v=[0-9a-f]{12}$`);
      expect(done.body.user).toMatchObject({ handle, displayName: 'Asha R', avatarUrl: expect.stringMatching(ours) });
      expect(fetched.at(-1)).toBe('https://lh3.googleusercontent.com/a/test-asha=s256-c');
      const session = cookiesOf(done)[SESSION_COOKIE];
      expect(session).toMatch(/^[\w-]{43}$/);
      expect(cookiesOf(done)[SIGNUP_COOKIE]).toBe(''); // cleared
      const me = await request(app).get('/api/me').set('Cookie', `${SESSION_COOKIE}=${session ?? ''}`);
      expect(me.body.user).toMatchObject({ id: done.body.user.id, handle, avatarUrl: done.body.user.avatarUrl });
      const pic = await request(app).get(String(done.body.user.avatarUrl)).set('Cookie', `${SESSION_COOKIE}=${session ?? ''}`);
      expect(pic.status).toBe(200);
      expect(pic.headers['content-type']).toBe('image/webp');

      // Single use; and the next Google sign-in is a plain sign-in to this account.
      expect((await finish(signup, { handle: `${handle}2`, displayName: 'Asha' })).body.error.code).toBe('signup_expired');
      expect((await request(app).get('/api/auth/onboarding').set('Cookie', cookieHeader(signup))).status).toBe(404);
      const again = await start('google');
      const back = await callback('google', { state: again.state, code: 'abc' }, again.cookies);
      expect(back.headers.location).toBe('/c/x');
      expect((await request(app).get('/api/me').set('Cookie', `${SESSION_COOKIE}=${cookiesOf(back)[SESSION_COOKIE] ?? ''}`)).body.user.id).toBe(done.body.user.id);
    });

    it('needs a live signup, and re-checks the email when the account is created', async () => {
      expect((await request(app).get('/api/auth/onboarding')).body.error.code).toBe('signup_expired');
      expect((await finish({}, { handle: 'nobody_here', displayName: 'N' })).body.error.code).toBe('signup_expired');

      const signup = await pending();
      const other = await signIn(app, 'eml');
      await pool.query("INSERT INTO identities (user_id, provider, subject, email, email_verified) VALUES ($1, 'github', $2, $3, true)", [other.id, String(Date.now()), google.state.email]);
      const res = await finish(signup, { handle: `late_${randomBytes(3).toString('hex')}`, displayName: 'Late' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('account_exists');
    });
  });

  describe('signing out', () => {
    it('logout revokes this session only; logout-all revokes every session of the user', async () => {
      const a = await signIn(app, 'out');
      const second = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: a.handle });
      const b = `${SESSION_COOKIE}=${cookiesOf(second)[SESSION_COOKIE] ?? ''}`;
      const third = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: a.handle });
      const c = `${SESSION_COOKIE}=${cookiesOf(third)[SESSION_COOKIE] ?? ''}`;

      expect((await request(app).post('/api/auth/logout').set('Cookie', a.cookie)).status).toBe(403); // Origin check
      const out = await request(app).post('/api/auth/logout').set('Origin', WEB_ORIGIN).set('Cookie', a.cookie);
      expect(out.status).toBe(204);
      expect(cookiesOf(out)[SESSION_COOKIE]).toBe('');
      expect((await request(app).get('/api/me').set('Cookie', a.cookie)).status).toBe(401);
      expect((await request(app).get('/api/me').set('Cookie', b)).status).toBe(200);

      const all = await request(app).post('/api/auth/logout-all').set('Origin', WEB_ORIGIN).set('Cookie', b);
      expect(all.body).toEqual({ revoked: 2 });
      expect((await request(app).get('/api/me').set('Cookie', b)).status).toBe(401);
      expect((await request(app).get('/api/me').set('Cookie', c)).status).toBe(401);
      expect((await request(app).post('/api/auth/logout-all').set('Origin', WEB_ORIGIN).set('Cookie', c)).status).toBe(401);
    });
  });
});

describe.skipIf(!apiUrl)('TRUST_PROXY decides whose IP the sign-in limit counts', () => {
  const pool = appPool(apiUrl);
  afterAll(async () => {
    await pool.end();
  });
  const appWith = (trustProxy: '0' | '1') => {
    const config = testConfig({ DATABASE_URL: apiUrl, TRUST_PROXY: trustProxy, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
    const { logger } = captureLogger(config);
    const rateLimits = createRateLimits(pool, logger, { ...GENEROUS, auth: { points: 2, duration: 60 } }, `t${randomBytes(4).toString('hex')}:`);
    return createApp({ config, logger, pool, rateLimits, fetchAvatar });
  };
  const startFrom = (app: Express, ip: string) => request(app).get('/api/auth/github/start').set('X-Forwarded-For', ip);

  it('0: X-Forwarded-For is ignored, so a client cannot dodge the limit by forging it', async () => {
    const app = appWith('0');
    expect((await startFrom(app, '203.0.113.1')).status).toBe(302);
    expect((await startFrom(app, '203.0.113.2')).status).toBe(302);
    expect((await startFrom(app, '203.0.113.3')).status).toBe(429);
  });

  it('1: exactly one hop is trusted: the address the proxy saw counts, not what the client claimed', async () => {
    const app = appWith('1');
    expect((await startFrom(app, '198.51.100.1')).status).toBe(302);
    expect((await startFrom(app, '198.51.100.2')).status).toBe(302);
    expect((await startFrom(app, '198.51.100.2')).status).toBe(302);
    expect((await startFrom(app, '198.51.100.2')).status).toBe(429);
    // A client-supplied hop in front of the proxy's own entry changes nothing.
    expect((await startFrom(app, '10.9.9.9, 198.51.100.2')).status).toBe(429);
  });
});
