import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../errors.js';
import { insertSystemMessage } from './conversations.js';
import { withTx } from './pg.js';

/** How long a deleted account's handle stays unavailable to anyone else. */
export const HANDLE_HOLD_DAYS = 30;
export const DELETED_NAME = 'Deleted user';

export type DeleteResult = { groupsLeft: number; ownershipTransferred: number; messagesErased: number };

/**
 * Deletes an account, in one transaction:
 * - every active group membership closes with reason 'deleted' (after a `member_left` notice, so
 *   windows stay exact); an owner's groups pass to the longest-standing admin, else member;
 * - optionally, every text message the user sent becomes a tombstone (body erased; rows and seqs stay);
 * - the handle is held for HANDLE_HOLD_DAYS, then the row is emptied: handle `del_<hex>`, name
 *   "Deleted user", no avatar; disabled_at (which disconnects every socket) and deleted_at set;
 * - identities, sessions, blocks (both ways) and OAuth flows are removed.
 * Direct conversations keep both members (the other person keeps the history); new messages
 * there are refused by the database.
 */
export async function deleteAccount(pool: pg.Pool, userId: string, opts: { eraseMessages: boolean }): Promise<DeleteResult> {
  return withTx(pool, async (tx) => {
    const { rows: [user] } = await tx.query<{ handle: string }>(
      'SELECT handle FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [userId],
    );
    if (!user) throw new HttpError(404, 'not_found', 'Account not found');

    // Same lock order as leaving: membership first, then (via the trigger) the conversation.
    const { rows: groups } = await tx.query<{ id: string; conversation_id: string; role: string }>(
      `SELECT p.id, p.conversation_id, p.role FROM conversation_memberships p JOIN conversations c ON c.id = p.conversation_id
        WHERE p.user_id = $1 AND p.left_at IS NULL AND c.kind = 'group'
        ORDER BY p.conversation_id FOR UPDATE OF p`,
      [userId],
    );
    let ownershipTransferred = 0;
    for (const g of groups) {
      if (g.role === 'owner') {
        const { rows: [next] } = await tx.query<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM conversation_memberships
            WHERE conversation_id = $1 AND left_at IS NULL AND user_id <> $2
            ORDER BY role = 'admin' DESC, joined_at, id LIMIT 1 FOR UPDATE`,
          [g.conversation_id, userId],
        );
        if (next) {
          await tx.query("UPDATE conversation_memberships SET role = 'member' WHERE id = $1", [g.id]);
          await tx.query("UPDATE conversation_memberships SET role = 'owner' WHERE id = $1", [next.id]);
          await insertSystemMessage(tx, g.conversation_id, { event: 'owner_changed', actor: userId, target: next.user_id });
          ownershipTransferred++;
        }
      }
      await insertSystemMessage(tx, g.conversation_id, { event: 'member_left', actor: userId });
      await tx.query("UPDATE conversation_memberships SET left_at = now(), left_reason = 'deleted' WHERE id = $1", [g.id]);
    }

    let messagesErased = 0;
    if (opts.eraseMessages) {
      const { rowCount } = await tx.query(
        "UPDATE messages SET deleted_at = now() WHERE sender_id = $1 AND kind = 'text' AND deleted_at IS NULL", [userId],
      );
      messagesErased = rowCount ?? 0;
    }

    await tx.query(
      `INSERT INTO handle_holds (handle, user_id, held_until) VALUES (lower($1), $2, now() + make_interval(days => $3))
       ON CONFLICT (handle) DO UPDATE SET user_id = EXCLUDED.user_id, held_until = EXCLUDED.held_until`,
      [user.handle, userId, HANDLE_HOLD_DAYS],
    );
    await tx.query(
      `UPDATE users SET handle = $2, display_name = $3, avatar_url = NULL, disabled_at = now(), deleted_at = now()
        WHERE id = $1`,
      [userId, `del_${randomBytes(8).toString('hex')}`, DELETED_NAME],
    );
    await tx.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM identities WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1', [userId]);
    await tx.query('DELETE FROM oauth_flows WHERE user_id = $1', [userId]);
    // Uploads never sent go in both modes (with eraseMessages, the tombstones above already
    // marked every attachment of the user's messages).
    await tx.query('UPDATE attachments SET deleted_at = now() WHERE uploader_id = $1 AND message_id IS NULL AND deleted_at IS NULL', [userId]);
    return { groupsLeft: groups.length, ownershipTransferred, messagesErased };
  });
}
