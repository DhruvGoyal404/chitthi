import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { isUniqueViolation, withTx } from '../repo/pg.js';
import { sha256, type Profile, type Provider } from './flows.js';

export type SignInResult =
  | { kind: 'user'; userId: string }
  | { kind: 'pending'; token: string }
  | { kind: 'error'; error: 'account_exists' | 'account_disabled' };

/** An active account other than `exceptUserId` already uses this email through some provider. */
async function emailInUse(q: Pick<pg.Pool, 'query'>, email: string, exceptUserId?: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `SELECT 1 FROM identities i JOIN users u ON u.id = i.user_id
      WHERE lower(i.email) = lower($1) AND i.provider <> 'dev' AND u.disabled_at IS NULL
        AND ($2::uuid IS NULL OR u.id <> $2) LIMIT 1`,
    [email, exceptUserId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Signs in by (provider, subject).
 * - A known identity signs its account in.
 * - A new identity whose email already belongs to an account is REFUSED: identities are never linked
 *   by email (a provider vouching for an address is not proof of owning the existing account). The
 *   person signs in the way they did before and links this provider from the account page.
 * - Otherwise a pending signup holds the verified profile until onboarding picks a handle; no user
 *   exists until then.
 */
export async function signInWith(pool: pg.Pool, provider: Provider, profile: Profile): Promise<SignInResult> {
  const { rows: [known] } = await pool.query<{ user_id: string; disabled: boolean }>(
    `SELECT i.user_id, u.disabled_at IS NOT NULL AS disabled
       FROM identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = $1 AND i.subject = $2`,
    [provider, profile.subject],
  );
  if (known) {
    if (known.disabled) return { kind: 'error', error: 'account_disabled' };
    await pool.query(
      'UPDATE identities SET email = $3, email_verified = true, last_used_at = now() WHERE provider = $1 AND subject = $2',
      [provider, profile.subject, profile.email],
    );
    return { kind: 'user', userId: known.user_id };
  }
  if (await emailInUse(pool, profile.email)) return { kind: 'error', error: 'account_exists' };

  const token = randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM pending_signups WHERE expires_at < now()');
  await pool.query(
    `INSERT INTO pending_signups (token_hash, provider, subject, email, display_name, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sha256(token), provider, profile.subject, profile.email, profile.name.slice(0, 60), profile.avatarUrl],
  );
  return { kind: 'pending', token };
}

export type LinkResult = 'linked' | 'already_linked' | 'identity_in_use' | 'provider_already_linked' | 'account_exists';

/**
 * Explicit linking by a signed-in user (from the account page): attaches this provider identity to
 * their account, unless it belongs to another account, the user already has this provider, or the
 * verified email belongs to a different account (that one should link it instead).
 */
export function linkIdentity(pool: pg.Pool, userId: string, provider: Provider, profile: Profile): Promise<LinkResult> {
  return withTx(pool, async (tx) => {
    const { rows: [owner] } = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM identities WHERE provider = $1 AND subject = $2', [provider, profile.subject],
    );
    if (owner) return owner.user_id === userId ? 'already_linked' : 'identity_in_use';
    const { rowCount } = await tx.query('SELECT 1 FROM identities WHERE user_id = $1 AND provider = $2', [userId, provider]);
    if (rowCount) return 'provider_already_linked';
    if (await emailInUse(tx, profile.email, userId)) return 'account_exists';
    await tx.query(
      `INSERT INTO identities (user_id, provider, subject, email, email_verified) VALUES ($1, $2, $3, $4, true)`,
      [userId, provider, profile.subject, profile.email],
    );
    return 'linked' as const;
  }).catch((err: unknown) => {
    if (isUniqueViolation(err, 'identities_provider_subject_key')) return 'identity_in_use' as const;
    if (isUniqueViolation(err, 'identities_user_provider_key')) return 'provider_already_linked' as const;
    throw err;
  });
}

export type Identity = { provider: Provider; email: string | null; linkedAt: Date };

/** The sign-in methods on an account (the dev shortcut is not one). */
export async function identitiesOf(pool: pg.Pool, userId: string): Promise<Identity[]> {
  const { rows } = await pool.query<Identity>(
    `SELECT provider, email, created_at AS "linkedAt" FROM identities
      WHERE user_id = $1 AND provider <> 'dev' ORDER BY provider`,
    [userId],
  );
  return rows;
}
