import type { GithubConfig } from '../config.js';
import { OAuthError, safeAvatar, type Flow, type Profile } from './flows.js';

const TIMEOUT = 10_000;

/** GitHub's authorization endpoint: code flow with state and PKCE S256. */
export function githubAuthorizeUrl(cfg: GithubConfig, redirectUri: string, f: { state: string; codeChallenge: string }): string {
  const url = new URL(cfg.authUrl);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    state: f.state,
    code_challenge: f.codeChallenge,
    code_challenge_method: 'S256',
    allow_signup: 'true',
  }).toString();
  return url.toString();
}

/** fetch with a timeout; the JSON body comes back untyped (callers check every field). */
async function call(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) }).catch((err: unknown) => {
    throw new OAuthError('provider_unreachable', String(err));
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

type Json = Record<string, unknown>;
const field = (body: unknown, key: string): unknown => (body !== null && typeof body === 'object' ? (body as Json)[key] : undefined);

/**
 * Exchanges the code (with the PKCE verifier) for a short-lived access token, reads the user and
 * their VERIFIED PRIMARY email, and drops the token. Nothing is stored but id, email, name, avatar.
 */
export async function githubProfile(cfg: GithubConfig, redirectUri: string, code: string, flow: Flow): Promise<Profile> {
  const token = await call(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: flow.codeVerifier,
    }),
  });
  const accessToken = field(token.body, 'access_token');
  if (!token.ok || typeof accessToken !== 'string') {
    const reason = field(token.body, 'error');
    throw new OAuthError('token_exchange_failed', `token endpoint: ${String(token.status)} ${typeof reason === 'string' ? reason : ''}`);
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Chitthi',
  };
  const user = await call(`${cfg.apiUrl}/user`, { headers });
  const emails = await call(`${cfg.apiUrl}/user/emails`, { headers });
  const id = field(user.body, 'id');
  const login = field(user.body, 'login');
  if (!user.ok || typeof id !== 'number' || typeof login !== 'string') {
    throw new OAuthError('token_exchange_failed', `user endpoint: ${String(user.status)}`);
  }
  if (!emails.ok || !Array.isArray(emails.body)) throw new OAuthError('email_unverified', `emails endpoint: ${String(emails.status)}`);
  const primary = (emails.body as unknown[]).find((e) => field(e, 'primary') === true && field(e, 'verified') === true);
  const email = field(primary, 'email');
  if (typeof email !== 'string') throw new OAuthError('email_unverified');
  const rawName = field(user.body, 'name');
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : login;
  return { subject: String(id), email, name, avatarUrl: safeAvatar(field(user.body, 'avatar_url')) };
}
