import { parseCookie } from 'cookie';
import { Router, type Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import { requireSession, sessionOf } from '../auth.js';
import type { Config } from '../config.js';
import { HttpError } from '../errors.js';
import { SESSION_COOKIE, sessionToken, startSession, type SessionStore } from '../sessions.js';
import { identitiesOf, linkIdentity, signInWith } from './accounts.js';
import { consumeFlow, isProvider, OAuthError, safeReturnTo, startFlow, type Flow, type Profile, type Provider } from './flows.js';
import { completeSignup, pendingSignup } from './onboarding.js';
import type { Avatars } from '../media/avatars.js';
import { getUser } from '../repo/users.js';
import { githubAuthorizeUrl, githubProfile } from './github.js';
import { googleAuthorizeUrl, googleProfile } from './google.js';

/** Binds a flow to the browser that started it (login CSRF defence); compared with ?state on return. */
export const FLOW_COOKIE = 'chitthi_oauth';
/** A first sign-in waiting for onboarding (the token of a pending_signups row). */
export const SIGNUP_COOKIE = 'chitthi_signup';
export const AUTH_COOKIE_PATH = '/api/auth';

const signupBody = z.object({
  handle: z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/, '3–20 characters: letters, digits or _'),
  displayName: z.string().trim().min(1).max(60),
});

const notFound = () => new HttpError(404, 'not_found', 'Not found');

export function oauthRouter(pool: pg.Pool, sessions: SessionStore, config: Config, logger: Logger, avatars?: Avatars): Router {
  const router = Router();
  const secure = config.nodeEnv === 'production';
  const redirectUri = (p: Provider) => `${config.publicOrigin}/api/auth/${p}/callback`;
  const configured = (p: string): p is Provider => isProvider(p) && config[p] !== undefined;

  const authorizeUrl = (p: Provider, f: { state: string; codeChallenge: string; nonce: string | null }): string => {
    if (p === 'google' && config.google) return googleAuthorizeUrl(config.google, redirectUri(p), f);
    if (p === 'github' && config.github) return githubAuthorizeUrl(config.github, redirectUri(p), f);
    throw notFound();
  };
  const profileFor = (p: Provider, code: string, flow: Flow): Promise<Profile> => {
    if (p === 'google' && config.google) return googleProfile(config.google, redirectUri(p), code, flow);
    if (p === 'github' && config.github) return githubProfile(config.github, redirectUri(p), code, flow);
    throw notFound();
  };

  async function begin(res: Response, provider: Provider, purpose: 'login' | 'link', returnTo: string, userId?: string) {
    const f = await startFlow(pool, { provider, purpose, returnTo, ...(userId !== undefined && { userId }) });
    res.cookie(FLOW_COOKIE, f.state, { httpOnly: true, sameSite: 'lax', secure, path: AUTH_COOKIE_PATH, maxAge: 10 * 60 * 1000 });
    res.redirect(302, authorizeUrl(provider, f));
  }

  /** Which sign-in options the sign-in page offers. */
  router.get('/auth/providers', (_req, res) => {
    res.json({ google: config.google !== undefined, github: config.github !== undefined, dev: config.devLogin });
  });

  router.get('/auth/:provider/start', async (req, res) => {
    const { provider } = req.params;
    if (!configured(provider)) throw notFound();
    await begin(res, provider, 'login', safeReturnTo(req.query.next));
  });

  // A signed-in user explicitly adds a provider to their account (never automatic, never by email).
  router.get('/auth/:provider/link', requireSession(sessions), async (req, res) => {
    const provider = String(req.params.provider);
    if (!configured(provider)) throw notFound();
    await begin(res, provider, 'link', '/account', sessionOf(res).user.id);
  });

  router.get('/auth/:provider/callback', async (req, res) => {
    const { provider } = req.params;
    if (!configured(provider)) throw notFound();
    const cookieState = parseCookie(req.get('cookie') ?? '')[FLOW_COOKIE];
    res.clearCookie(FLOW_COOKIE, { path: AUTH_COOKIE_PATH });
    const fail = (code: string, flow?: Flow) => {
      const page = flow?.purpose === 'link' ? '/account' : '/signin';
      res.redirect(302, `${page}?error=${encodeURIComponent(code)}&provider=${provider}`);
    };

    const { state, code, error } = req.query;
    if (typeof error === 'string') {
      fail(error === 'access_denied' ? 'cancelled' : 'provider_error');
      return;
    }
    // The state must match the cookie set when THIS browser started the flow, and be unused.
    if (typeof state !== 'string' || typeof code !== 'string' || !cookieState || cookieState !== state) {
      fail('state_mismatch');
      return;
    }
    const flow = await consumeFlow(pool, state);
    if (!flow || flow.provider !== provider) {
      fail('state_invalid');
      return;
    }

    let profile: Profile;
    try {
      profile = await profileFor(provider, code, flow);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      logger.warn({ provider, code: err.code, detail: err.message }, 'sign-in rejected');
      fail(err.code, flow);
      return;
    }

    if (flow.purpose === 'link') {
      // Only for the same signed-in user who started it, in this browser.
      const token = sessionToken(req);
      const session = token ? await sessions.find(token) : undefined;
      if (!session || session.user.id !== flow.userId) {
        fail('link_session_changed', flow);
        return;
      }
      const linked = await linkIdentity(pool, session.user.id, provider, profile);
      if (linked === 'linked' || linked === 'already_linked') res.redirect(302, `/account?linked=${provider}`);
      else fail(linked, flow);
      return;
    }

    const result = await signInWith(pool, provider, profile);
    if (result.kind === 'error') {
      fail(result.error, flow);
      return;
    }
    if (result.kind === 'pending') {
      res.cookie(SIGNUP_COOKIE, result.token, { httpOnly: true, sameSite: 'lax', secure, path: AUTH_COOKIE_PATH, maxAge: 30 * 60 * 1000 });
      res.redirect(302, '/welcome');
      return;
    }
    // The picture may have changed at the provider: our copy follows it at every sign-in.
    await avatars?.refresh(result.userId, profile.avatarUrl);
    // Rotation: any session this browser had is revoked before the new one is issued.
    await startSession(sessions, req, res, result.userId, secure);
    res.redirect(302, flow.returnTo);
  });

  // First sign-in: the welcome page shows the provider's profile and a suggested handle…
  router.get('/auth/onboarding', async (req, res) => {
    res.json(await pendingSignup(pool, parseCookie(req.get('cookie') ?? '')[SIGNUP_COOKIE]));
  });

  // …and creating the account signs it in (a fresh session; any previous one is revoked).
  router.post('/auth/onboarding', async (req, res) => {
    const input = signupBody.parse(req.body);
    const created = await completeSignup(pool, parseCookie(req.get('cookie') ?? '')[SIGNUP_COOKIE], input);
    res.clearCookie(SIGNUP_COOKIE, { path: AUTH_COOKIE_PATH });
    // Our copy of the provider's picture (kept in avatar_url by the signup), before answering.
    await avatars?.refresh(created.id);
    const user = (await getUser(pool, created.id)) ?? created;
    await startSession(sessions, req, res, user.id, secure);
    res.status(201).json({ user });
  });

  // Revoking a session also disconnects its sockets (the sessions trigger notifies the realtime server).
  router.post('/auth/logout', async (req, res) => {
    const token = sessionToken(req);
    if (token) await sessions.revoke(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.post('/auth/logout-all', requireSession(sessions), async (_req, res) => {
    const revoked = await sessions.revokeAll(sessionOf(res).user.id);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ revoked });
  });

  router.get('/auth/identities', requireSession(sessions), async (_req, res) => {
    res.json({ identities: await identitiesOf(pool, sessionOf(res).user.id) });
  });

  return router;
}
