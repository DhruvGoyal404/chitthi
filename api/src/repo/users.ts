import type pg from 'pg';
import { HttpError } from '../errors.js';
import { isUniqueViolation, violates, withTx } from './pg.js';

export type User = { id: string; handle: string; displayName: string };

const USER_COLUMNS = 'u.id, u.handle, u.display_name AS "displayName"';

/**
 * The dev sign-in's user: identity ('dev', lower(handle)) → user, created on first use with the
 * handle as display name. Development and test only (devLogin.ts guards the caller).
 */
export async function findOrCreateDevUser(pool: pg.Pool, handle: string): Promise<User> {
  const subject = handle.toLowerCase();
  const find = async (): Promise<User | undefined> => {
    const { rows } = await pool.query<User>(
      `SELECT ${USER_COLUMNS} FROM identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = 'dev' AND i.subject = $1 AND u.disabled_at IS NULL`,
      [subject],
    );
    return rows[0];
  };
  const existing = await find();
  if (existing) return existing;
  try {
    return await withTx(pool, async (tx) => {
      const { rows: [user] } = await tx.query<User>(
        `INSERT INTO users AS u (handle, display_name) VALUES ($1, $1) RETURNING ${USER_COLUMNS}`,
        [handle],
      );
      if (!user) throw new Error('insert returned no row');
      await tx.query(`INSERT INTO identities (user_id, provider, subject) VALUES ($1, 'dev', $2)`, [user.id, subject]);
      return user;
    });
  } catch (err) {
    // Two first sign-ins racing: the loser finds the winner's user.
    if (isUniqueViolation(err, 'identities_provider_subject_key')) {
      const winner = await find();
      if (winner) return winner;
    }
    throw mapUserError(err);
  }
}

/** Maps handle constraints to client errors; anything else passes through unchanged. */
export function mapUserError(err: unknown): unknown {
  if (isUniqueViolation(err, 'users_handle_lower_key')) return new HttpError(409, 'handle_taken', 'That handle is taken');
  if (violates(err, 'users_handle_reserved')) return new HttpError(400, 'handle_reserved', 'That handle is reserved');
  if (violates(err, 'users_handle_format')) return new HttpError(400, 'invalid_handle', 'Handles are 3–20 characters: letters, digits or _');
  return err;
}
