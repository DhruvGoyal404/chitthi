import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

export type Provider = 'google' | 'github';
export const PROVIDERS: readonly Provider[] = ['google', 'github'];
export const isProvider = (p: string): p is Provider => (PROVIDERS as readonly string[]).includes(p);

/** A sign-in failure with a code the sign-in / account page explains (?error=code). */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

/** What a provider vouches for. Only verified emails ever get this far. */
export type Profile = { subject: string; email: string; name: string; avatarUrl: string | null };

const random = (bytes: number) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** RFC 7636 S256 challenge for a PKCE verifier. */
export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

export type Flow = {
  provider: Provider;
  purpose: 'login' | 'link';
  userId: string | null;
  codeVerifier: string;
  nonce: string | null;
  returnTo: string;
};

/** In-app paths only, so ?next= can never redirect off-site. */
export function safeReturnTo(next: unknown, fallback = '/'): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && next.length <= 500
    ? next
    : fallback;
}

/** Only https avatars, short enough to store (the DB checks the same). */
export function safeAvatar(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 500) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Starts a flow: a random state (stored hashed), a PKCE verifier and, for OIDC, a nonce. Expired
 * flows are swept on the way.
 */
export async function startFlow(
  pool: pg.Pool,
  input: { provider: Provider; purpose: 'login' | 'link'; userId?: string; returnTo: string },
): Promise<{ state: string; codeChallenge: string; nonce: string | null }> {
  const state = random(32);
  const codeVerifier = random(48); // 64 characters, within RFC 7636's 43–128
  const nonce = input.provider === 'google' ? random(24) : null;
  await pool.query('DELETE FROM oauth_flows WHERE expires_at < now()');
  await pool.query(
    `INSERT INTO oauth_flows (state_hash, provider, purpose, user_id, code_verifier, nonce, return_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [sha256(state), input.provider, input.purpose, input.userId ?? null, codeVerifier, nonce, input.returnTo],
  );
  return { state, codeChallenge: pkceChallenge(codeVerifier), nonce };
}

/** Takes the flow for a state exactly once; a replayed, unknown or expired state gets nothing. */
export async function consumeFlow(pool: pg.Pool, state: string): Promise<Flow | undefined> {
  const { rows: [r] } = await pool.query<{
    provider: Provider; purpose: 'login' | 'link'; user_id: string | null; code_verifier: string; nonce: string | null; return_to: string;
  }>(
    `DELETE FROM oauth_flows WHERE state_hash = $1 AND expires_at > now()
     RETURNING provider, purpose, user_id, code_verifier, nonce, return_to`,
    [sha256(state)],
  );
  return r && {
    provider: r.provider, purpose: r.purpose, userId: r.user_id, codeVerifier: r.code_verifier, nonce: r.nonce, returnTo: r.return_to,
  };
}
