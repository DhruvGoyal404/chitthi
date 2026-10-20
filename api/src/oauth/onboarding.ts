import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../errors.js';
import { mapUserError, type Me } from '../repo/users.js';
import { isUniqueViolation, withTx } from '../repo/pg.js';
import { sha256, type Provider } from './flows.js';

export type PendingSignup = { provider: Provider; email: string; displayName: string; avatarUrl: string | null; suggestedHandle: string };

const expired = () => new HttpError(404, 'signup_expired', 'This sign-in has expired. Please start again.');

/** A handle the database would accept and nobody holds: from the email's local part, else the name. */
async function suggestHandle(pool: pg.Pool, email: string, name: string): Promise<string> {
  const clean = (s: string) => s.normalize('NFKD').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16);
  let base = clean(email.split('@')[0] ?? '');
  if (base.length < 3) base = clean(name);
  if (base.length < 3) base = 'letter';
  const candidates = [base, ...Array.from({ length: 4 }, () => `${base}${String(randomInt(10, 9999))}`)];
  const { rows } = await pool.query<{ handle: string }>(
    `SELECT c AS handle FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n)
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.handle) = lower(c))
        AND NOT EXISTS (SELECT 1 FROM reserved_handles r WHERE r.handle = lower(c))
      ORDER BY n LIMIT 1`,
    [candidates],
  );
  return rows[0]?.handle ?? '';
}

/** What the welcome page prefills, from the provider's verified profile. */
export async function pendingSignup(pool: pg.Pool, token: string | undefined): Promise<PendingSignup> {
  if (!token) throw expired();
  const { rows: [row] } = await pool.query<{ provider: Provider; email: string; display_name: string; avatar_url: string | null }>(
    'SELECT provider, email, display_name, avatar_url FROM pending_signups WHERE token_hash = $1 AND expires_at > now()',
    [sha256(token)],
  );
  if (!row) throw expired();
  return {
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    suggestedHandle: await suggestHandle(pool, row.email, row.display_name),
  };
}

/**
 * Finishes a first sign-in: in one transaction the pending signup is consumed and the user and its
 * identity are created. A taken or reserved handle rolls everything back, so the person can pick
 * another with the same token.
 */
export async function completeSignup(pool: pg.Pool, token: string | undefined, input: { handle: string; displayName: string }): Promise<Me> {
  if (!token) throw expired();
  try {
    return await withTx(pool, async (tx) => {
      const { rows: [p] } = await tx.query<{ provider: Provider; subject: string; email: string; avatar_url: string | null }>(
        'DELETE FROM pending_signups WHERE token_hash = $1 AND expires_at > now() RETURNING provider, subject, email, avatar_url',
        [sha256(token)],
      );
      if (!p) throw expired();
      // Checked again: the email may have been linked to an account since the callback.
      const { rowCount } = await tx.query(
        `SELECT 1 FROM identities i JOIN users u ON u.id = i.user_id
          WHERE lower(i.email) = lower($1) AND i.provider <> 'dev' AND u.disabled_at IS NULL`,
        [p.email],
      );
      if (rowCount) throw new HttpError(409, 'account_exists', 'An account already uses this email. Sign in the way you did before.');
      const { rows: [user] } = await tx.query<Me>(
        `INSERT INTO users AS u (handle, display_name, avatar_url) VALUES ($1, $2, $3)
         RETURNING u.id, u.handle, u.display_name AS "displayName", u.avatar_url AS "avatarUrl"`,
        [input.handle, input.displayName, p.avatar_url],
      );
      if (!user) throw new Error('insert returned no row');
      await tx.query(
        'INSERT INTO identities (user_id, provider, subject, email, email_verified) VALUES ($1, $2, $3, $4, true)',
        [user.id, p.provider, p.subject, p.email],
      );
      return user;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'identities_provider_subject_key')) {
      throw new HttpError(409, 'identity_in_use', 'This sign-in already has an account. Sign in again.');
    }
    throw mapUserError(err);
  }
}
