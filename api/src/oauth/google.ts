import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { GoogleConfig } from '../config.js';
import { OAuthError, safeAvatar, type Flow, type Profile } from './flows.js';

const TIMEOUT = 10_000;

// One cached key set per JWKS URL; jose refetches on an unknown kid (key rotation) with a cooldown.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function keysFor(url: string) {
  let jwks = keySets.get(url);
  if (!jwks) keySets.set(url, (jwks = createRemoteJWKSet(new URL(url), { timeoutDuration: TIMEOUT })));
  return jwks;
}

/** Google's authorization endpoint: code flow, PKCE S256, state and nonce. */
export function googleAuthorizeUrl(cfg: GoogleConfig, redirectUri: string, f: { state: string; codeChallenge: string; nonce: string | null }): string {
  const url = new URL(cfg.authUrl);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: f.state,
    nonce: f.nonce ?? '',
    code_challenge: f.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

/**
 * Exchanges the code (with the PKCE verifier) and validates the ID token with jose against Google's
 * JWKS: signature (RS256), iss, aud, exp (30 s clock tolerance), the nonce from this flow, and
 * email_verified. No access or refresh token is kept: nothing from the token response is stored.
 */
export async function googleProfile(cfg: GoogleConfig, redirectUri: string, code: string, flow: Flow): Promise<Profile> {
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: flow.codeVerifier,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch((err: unknown) => {
    throw new OAuthError('provider_unreachable', String(err));
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown };
  if (!res.ok || typeof body.id_token !== 'string') throw new OAuthError('token_exchange_failed', `token endpoint returned ${String(res.status)}`);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(body.id_token, keysFor(cfg.jwksUrl), {
      issuer: cfg.issuers,
      audience: cfg.clientId,
      algorithms: ['RS256'],
      // Up to a minute of clock drift between Google and this server (iat a little in the
      // future, exp a little in the past) doesn't break sign-in.
      clockTolerance: 60,
      // Google's ID tokens live an hour. Without maxTokenAge jose never looks at iat, so a token
      // stamped in the future would pass; with it, iat must be in the past (within the tolerance)
      // and no older than the hour.
      maxTokenAge: '1h',
      requiredClaims: ['sub', 'exp', 'iat'],
    }));
  } catch (err) {
    throw new OAuthError('invalid_id_token', err instanceof Error ? `${err.name}: ${err.message}` : 'unverifiable');
  }
  if (!flow.nonce || payload.nonce !== flow.nonce) throw new OAuthError('invalid_id_token', 'nonce mismatch');
  if (payload.email_verified !== true || typeof payload.email !== 'string') throw new OAuthError('email_unverified');
  const email = payload.email;
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : (email.split('@')[0] ?? email);
  return { subject: payload.sub ?? '', email, name, avatarUrl: safeAvatar(payload.picture) };
}
