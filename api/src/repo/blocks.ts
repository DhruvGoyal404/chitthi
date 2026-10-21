import type pg from 'pg';
import { HttpError } from '../errors.js';
import { assertUuid } from './access.js';
import { withTx, type Queryable } from './pg.js';

/** Between me and someone else: nothing, I blocked them, or they blocked me (mine wins if both). */
export type BlockState = 'by_me' | 'by_them' | null;

export type BlockedUser = { userId: string; handle: string; displayName: string; blockedAt: string };

/**
 * The same 403 for every refused path. Someone who was blocked can infer it from this (as in any
 * messenger, the refusal itself tells them); the wording stays neutral. The blocker is told
 * plainly, since they can undo it.
 */
export function blockedError(state: Exclude<BlockState, null>, what: 'message' | 'add'): HttpError {
  if (state === 'by_me') {
    return new HttpError(403, 'blocked', what === 'message'
      ? 'You blocked this person. Unblock them to send messages.'
      : 'You blocked this person. Unblock them first.');
  }
  return new HttpError(403, 'blocked', what === 'message' ? "You can't message this person." : "You can't add this person.");
}

export async function blockState(q: Queryable, me: string, other: string): Promise<BlockState> {
  const { rows: [row] } = await q.query<{ by_me: boolean; by_them: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2) AS by_me,
            EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = $2 AND blocked_id = $1) AS by_them`,
    [me, other],
  );
  return row?.by_me ? 'by_me' : row?.by_them ? 'by_them' : null;
}

/** Of `ids`, those who have blocked `me` (they can't be put in a group by me). */
export async function blockedMe(q: Queryable, me: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await q.query<{ blocker_id: string }>(
    'SELECT blocker_id FROM user_blocks WHERE blocked_id = $1 AND blocker_id = ANY($2::uuid[])', [me, ids],
  );
  return rows.map((r) => r.blocker_id);
}

/**
 * Blocks `blockedId`. Takes the lock of their direct conversation (if any) first, so the block
 * and a concurrent send there are ordered: a send either commits before the block or is refused.
 */
export async function block(pool: pg.Pool, blockerId: string, blockedId: string): Promise<{ created: boolean }> {
  assertUuid(blockedId, 'User');
  if (blockerId === blockedId) throw new HttpError(400, 'invalid_request', 'You cannot block yourself');
  const { rowCount: exists } = await pool.query('SELECT 1 FROM users WHERE id = $1', [blockedId]);
  if (!exists) throw new HttpError(404, 'user_not_found', 'User not found');
  const [lo, hi] = blockerId < blockedId ? [blockerId, blockedId] : [blockedId, blockerId];
  return withTx(pool, async (tx) => {
    await tx.query(
      `SELECT 1 FROM conversations c JOIN direct_conversations d ON d.conversation_id = c.id
        WHERE d.user_lo = $1 AND d.user_hi = $2 FOR UPDATE OF c`,
      [lo, hi],
    );
    const { rowCount } = await tx.query(
      'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [blockerId, blockedId],
    );
    return { created: (rowCount ?? 0) > 0 };
  });
}

export async function unblock(pool: pg.Pool, blockerId: string, blockedId: string): Promise<void> {
  assertUuid(blockedId, 'User');
  await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
}

export async function listBlocked(pool: pg.Pool, blockerId: string): Promise<BlockedUser[]> {
  const { rows } = await pool.query<BlockedUser>(
    `SELECT u.id AS "userId", u.handle, u.display_name AS "displayName", b.created_at AS "blockedAt"
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [blockerId],
  );
  return rows;
}

/** SQL: no block in either direction between the users in columns/params `a` and `b`. */
export const notBlocked = (a: string, b: string) =>
  `NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE (ub.blocker_id = ${a} AND ub.blocked_id = ${b}) OR (ub.blocker_id = ${b} AND ub.blocked_id = ${a}))`;

/** The 403 for a send or edit the trigger refused in a direct conversation, worded for `me`. */
export async function directBlockError(q: Queryable, conversationId: string, me: string): Promise<HttpError> {
  const { rows: [d] } = await q.query<{ other: string }>(
    'SELECT CASE WHEN user_lo = $2 THEN user_hi ELSE user_lo END AS other FROM direct_conversations WHERE conversation_id = $1',
    [conversationId, me],
  );
  const state = d ? await blockState(q, me, d.other) : null;
  return blockedError(state ?? 'by_them', 'message');
}
