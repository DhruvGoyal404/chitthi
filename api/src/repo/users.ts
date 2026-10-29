import type pg from 'pg';
import { HttpError } from '../errors.js';
import { isUniqueViolation, violates, withTx } from './pg.js';

/** avatarUrl: our own copy of the person's picture (/api/users/<id>/avatar), or null for initials. */
export type User = { id: string; handle: string; displayName: string; avatarUrl: string | null };

/**
 * The address of a user's stored avatar, as SQL over the users row `alias`. The ?v= part changes
 * whenever the picture does, so a browser's cached copy is never stale. Served only to the user
 * and to people who share a conversation with them (media/avatars.ts); anyone else gets a 404.
 */
export const avatarUrlSql = (alias: string) =>
  `CASE WHEN ${alias}.avatar_key IS NULL THEN NULL ELSE '/api/users/' || ${alias}.id || '/avatar?v=' || left(${alias}.avatar_key, 12) END`;

/**
 * The same, but null unless `viewerParam` shares (or shared) a conversation with the user: for
 * lists that include strangers (search, blocks), whose avatar the server would refuse anyway.
 */
export const visibleAvatarUrlSql = (alias: string, viewerParam: string) =>
  `CASE WHEN EXISTS (SELECT 1 FROM conversation_memberships va JOIN conversation_memberships vb ON vb.conversation_id = va.conversation_id
                      WHERE va.user_id = ${viewerParam} AND vb.user_id = ${alias}.id)
        THEN ${avatarUrlSql(alias)} END`;

const USER_COLUMNS = `u.id, u.handle, u.display_name AS "displayName", ${avatarUrlSql('u')} AS "avatarUrl"`;
/** For lists that include strangers: the avatar only where the caller ($2 in those queries) may see it. */
const LISTED_COLUMNS = `u.id, u.handle, u.display_name AS "displayName", ${visibleAvatarUrlSql('u', '$2')} AS "avatarUrl"`;
/** The signed-in user's own view of themselves. */
export type Me = User;
const ME_COLUMNS = USER_COLUMNS;

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
  if (violates(err, 'users_handle_held')) return new HttpError(409, 'handle_taken', 'That handle is taken');
  if (violates(err, 'users_handle_format')) return new HttpError(400, 'invalid_handle', 'Handles are 3–20 characters: letters, digits or _');
  return err;
}

/** Exact, case-insensitive handle lookup of an active user who hasn't blocked the caller. */
export async function findUserByHandle(pool: pg.Pool, handle: string, callerId: string): Promise<User | undefined> {
  const { rows: [user] } = await pool.query<User>(
    `SELECT ${LISTED_COLUMNS} FROM users u WHERE lower(u.handle) = lower($1) AND u.disabled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $2)`, [handle, callerId],
  );
  return user;
}

export async function getUser(pool: pg.Pool, id: string): Promise<Me | undefined> {
  const { rows: [user] } = await pool.query<Me>(`SELECT ${ME_COLUMNS} FROM users u WHERE u.id = $1 AND u.disabled_at IS NULL`, [id]);
  return user;
}

/** Changes the caller's handle and/or display name; handle rules are enforced by the database. */
export async function updateProfile(pool: pg.Pool, id: string, patch: { handle?: string; displayName?: string }): Promise<Me> {
  try {
    const { rows: [user] } = await pool.query<Me>(
      `UPDATE users u SET handle = COALESCE($2, u.handle), display_name = COALESCE($3, u.display_name)
        WHERE u.id = $1 AND u.disabled_at IS NULL RETURNING ${ME_COLUMNS}`,
      [id, patch.handle ?? null, patch.displayName?.trim() ?? null],
    );
    if (!user) throw new HttpError(404, 'user_not_found', 'User not found');
    return user;
  } catch (err) {
    throw mapUserError(err);
  }
}

/**
 * Handle prefix search for starting a conversation: active users only, never the caller nor
 * anyone who blocked the caller, at most
 * `limit`. `_` is a LIKE wildcard, so it is escaped; handles contain nothing else special.
 */
export async function searchUsers(pool: pg.Pool, prefix: string, callerId: string, limit = 8): Promise<User[]> {
  const pattern = `${prefix.toLowerCase().replaceAll('_', '\\_')}%`;
  const { rows } = await pool.query<User>(
    `SELECT ${LISTED_COLUMNS} FROM users u
      WHERE lower(u.handle) LIKE $1 AND u.id <> $2 AND u.disabled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $2)
      ORDER BY lower(u.handle) LIMIT $3`,
    [pattern, callerId, limit],
  );
  return rows;
}
