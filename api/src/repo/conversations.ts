import type pg from 'pg';
import { HttpError } from '../errors.js';
import { accessOf, assertUuid, notFound, requireActive, type Role } from './access.js';
import { blockedError, blockedMe, blockState, type BlockState } from './blocks.js';
import { isUniqueViolation, violates, withTx, type Queryable } from './pg.js';
import { codePointLength } from './text.js';

export type Conversation = { id: string; kind: 'direct' | 'group'; title: string | null; createdBy: string; createdAt: Date };

const CONV_COLUMNS = 'c.id, c.kind, c.title, c.created_by AS "createdBy", c.created_at AS "createdAt"';
export const MAX_GROUP_MEMBERS = 256;

const userNotFound = () => new HttpError(404, 'user_not_found', 'User not found');
const forbidden = (message: string) => new HttpError(403, 'forbidden', message);

export async function insertSystemMessage(q: Queryable, conversationId: string, meta: Record<string, unknown>): Promise<number> {
  const { rows: [row] } = await q.query<{ seq: number }>(
    `INSERT INTO messages (conversation_id, kind, meta) VALUES ($1, 'system', $2) RETURNING seq`,
    [conversationId, JSON.stringify(meta)],
  );
  if (!row) throw new Error('insert returned no row');
  return row.seq;
}

async function requireLiveUsers(q: Queryable, ids: readonly string[]): Promise<void> {
  for (const id of ids) assertUuid(id, 'User', 400);
  const { rows: [row] } = await q.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL', [ids],
  );
  if (row?.n !== new Set(ids).size) throw userNotFound();
}

/**
 * The one direct conversation between two users, created on first use. `direct_conversations`
 * holds the ordered pair under a unique constraint; two concurrent first calls race on it and the
 * loser rolls back and returns the winner's conversation.
 */
export async function findOrCreateDirect(
  pool: pg.Pool, userId: string, otherId: string,
  /** Runs only when a new conversation is about to be created (e.g. a rate limit); may throw. */
  beforeCreate?: () => Promise<void>,
): Promise<{ conversation: Conversation; created: boolean }> {
  assertUuid(otherId, 'User', 400);
  if (userId === otherId) throw new HttpError(400, 'invalid_request', 'You cannot start a conversation with yourself');
  const [lo, hi] = userId < otherId ? [userId, otherId] : [otherId, userId];
  const find = async () => {
    const { rows: [row] } = await pool.query<Conversation>(
      `SELECT ${CONV_COLUMNS} FROM direct_conversations d JOIN conversations c ON c.id = d.conversation_id
        WHERE d.user_lo = $1 AND d.user_hi = $2`,
      [lo, hi],
    );
    return row;
  };
  const existing = await find();
  if (existing) return { conversation: existing, created: false };
  await requireLiveUsers(pool, [userId, otherId]);
  // An existing DM still opens (its history stays readable); a new one needs no block either way.
  const block = await blockState(pool, userId, otherId);
  if (block) throw blockedError(block, 'message');
  await beforeCreate?.();
  try {
    const conversation = await withTx(pool, async (tx) => {
      const { rows: [conv] } = await tx.query<Conversation>(
        `INSERT INTO conversations AS c (kind, created_by) VALUES ('direct', $1) RETURNING ${CONV_COLUMNS}`, [userId],
      );
      if (!conv) throw new Error('insert returned no row');
      await tx.query('INSERT INTO direct_conversations (conversation_id, user_lo, user_hi) VALUES ($1, $2, $3)', [conv.id, lo, hi]);
      await tx.query(
        `INSERT INTO conversation_memberships (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [conv.id, lo, hi],
      );
      return conv;
    });
    return { conversation, created: true };
  } catch (err) {
    if (isUniqueViolation(err, 'direct_conversations_pair_key')) {
      const winner = await find();
      if (winner) return { conversation: winner, created: false };
    }
    throw err;
  }
}

/** A group with the creator as owner. Every initial member sees the `group_created` message. */
export async function createGroup(pool: pg.Pool, input: { creatorId: string; title: string; memberIds: readonly string[] }): Promise<Conversation> {
  const title = input.title.trim();
  if (codePointLength(title) < 1 || codePointLength(title) > 80) throw new HttpError(400, 'invalid_request', 'Group titles are 1–80 characters');
  const others = [...new Set(input.memberIds)].filter((id) => id !== input.creatorId);
  if (others.length + 1 > MAX_GROUP_MEMBERS) throw new HttpError(400, 'invalid_request', `Groups have at most ${String(MAX_GROUP_MEMBERS)} members`);
  await requireLiveUsers(pool, [input.creatorId, ...others]);
  if ((await blockedMe(pool, input.creatorId, others)).length > 0) {
    throw new HttpError(403, 'blocked', "Some of the people you picked can't be added by you.");
  }
  return withTx(pool, async (tx) => {
    const { rows: [conv] } = await tx.query<Conversation>(
      `INSERT INTO conversations AS c (kind, title, created_by) VALUES ('group', $1, $2) RETURNING ${CONV_COLUMNS}`,
      [title, input.creatorId],
    );
    if (!conv) throw new Error('insert returned no row');
    await tx.query(`INSERT INTO conversation_memberships (conversation_id, user_id, role) VALUES ($1, $2, 'owner')`, [conv.id, input.creatorId]);
    if (others.length > 0) {
      await tx.query(
        `INSERT INTO conversation_memberships (conversation_id, user_id, role) SELECT $1, unnest($2::uuid[]), 'member'`,
        [conv.id, others],
      );
    }
    await insertSystemMessage(tx, conv.id, { event: 'group_created', actor: input.creatorId, members: [input.creatorId, ...others] });
    return conv;
  });
}

const canManage = (role: Role) => role === 'owner' || role === 'admin';

/**
 * Adds (or re-adds) a member to a group. The new period starts at the next seq, which is the
 * `member_added` message, so the new member sees how they arrived and nothing before it.
 */
export async function addMember(pool: pg.Pool, input: { conversationId: string; actorId: string; userId: string; role?: 'admin' | 'member' }): Promise<{ joinedSeq: number }> {
  assertUuid(input.conversationId, 'Conversation');
  const actor = await requireActive(pool, input.conversationId, input.actorId);
  if (actor.kind !== 'group') throw new HttpError(400, 'invalid_request', 'Direct conversations have exactly two members');
  if (!canManage(actor.activeRole)) throw forbidden('Only group owners and admins can add members');
  if (input.role === 'admin' && actor.activeRole !== 'owner') throw forbidden('Only the owner can add admins');
  await requireLiveUsers(pool, [input.userId]);
  // Someone who blocked the actor can't be added by them. (A block never removes anyone from a
  // group they are already in: see docs/AUTH.md.)
  if ((await blockState(pool, input.actorId, input.userId)) === 'by_them') throw blockedError('by_them', 'add');
  try {
    return await withTx(pool, async (tx) => {
      const { rows: [m] } = await tx.query<{ joined_seq: number }>(
        `INSERT INTO conversation_memberships (conversation_id, user_id, role) VALUES ($1, $2, $3) RETURNING joined_seq`,
        [input.conversationId, input.userId, input.role ?? 'member'],
      );
      if (!m) throw new Error('insert returned no row');
      await insertSystemMessage(tx, input.conversationId, { event: 'member_added', actor: input.actorId, target: input.userId });
      return { joinedSeq: m.joined_seq };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'memberships_one_active')) throw new HttpError(409, 'already_member', 'Already a member');
    throw err;
  }
}

/**
 * Closes the target's active period. The notice is inserted first, so it is the last message in
 * the closed window [joined_seq, left_seq]: the leaver keeps read-only access up to and including it.
 */
async function closeMembership(pool: pg.Pool, conversationId: string, userId: string, reason: 'left' | 'removed', meta: Record<string, unknown>): Promise<{ leftSeq: number }> {
  return withTx(pool, async (tx) => {
    // Lock the active period first (same lock order as the membership trigger: membership, then conversation).
    const { rows: [active] } = await tx.query<{ id: string }>(
      'SELECT id FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL FOR UPDATE',
      [conversationId, userId],
    );
    if (!active) throw new HttpError(404, 'not_member', 'Not a member of this conversation');
    await insertSystemMessage(tx, conversationId, meta);
    const { rows: [closed] } = await tx.query<{ left_seq: number }>(
      `UPDATE conversation_memberships SET left_at = now(), left_reason = $2 WHERE id = $1 RETURNING left_seq`,
      [active.id, reason],
    );
    if (!closed) throw new Error('update returned no row');
    return { leftSeq: closed.left_seq };
  });
}

export async function removeMember(pool: pg.Pool, input: { conversationId: string; actorId: string; userId: string }): Promise<{ leftSeq: number }> {
  assertUuid(input.conversationId, 'Conversation');
  assertUuid(input.userId, 'User', 400);
  if (input.actorId === input.userId) throw new HttpError(400, 'invalid_request', 'Use leave to leave a conversation');
  const actor = await requireActive(pool, input.conversationId, input.actorId);
  if (actor.kind !== 'group') throw new HttpError(400, 'invalid_request', 'Members cannot be removed from a direct conversation');
  if (!canManage(actor.activeRole)) throw forbidden('Only group owners and admins can remove members');
  const target = await accessOf(pool, input.conversationId, input.userId);
  if (!target?.activeRole) throw new HttpError(404, 'not_member', 'Not a member of this conversation');
  if (target.activeRole === 'owner') throw forbidden('The owner cannot be removed');
  if (target.activeRole === 'admin' && actor.activeRole !== 'owner') throw forbidden('Only the owner can remove admins');
  return closeMembership(pool, input.conversationId, input.userId, 'removed', { event: 'member_removed', actor: input.actorId, target: input.userId });
}

/** Leaves a group. The owner must be the last active member to leave (no silent ownership change). */
export async function leave(pool: pg.Pool, input: { conversationId: string; userId: string }): Promise<{ leftSeq: number }> {
  assertUuid(input.conversationId, 'Conversation');
  const me = await requireActive(pool, input.conversationId, input.userId);
  if (me.kind === 'direct') throw new HttpError(409, 'cannot_leave_direct', 'You cannot leave a direct conversation');
  if (me.activeRole === 'owner') {
    const { rows: [row] } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM conversation_memberships WHERE conversation_id = $1 AND left_at IS NULL', [input.conversationId],
    );
    if ((row?.n ?? 0) > 1) throw new HttpError(409, 'owner_must_transfer', 'Transfer ownership before leaving');
  }
  try {
    return await closeMembership(pool, input.conversationId, input.userId, 'left', { event: 'member_left', actor: input.userId });
  } catch (err) {
    if (violates(err, 'memberships_direct_permanent')) throw new HttpError(409, 'cannot_leave_direct', 'You cannot leave a direct conversation');
    throw err;
  }
}

export type InboxEntry = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  /** The other participant of a direct conversation. */
  peer: { id: string; handle: string; displayName: string; deleted: boolean } | null;
  active: boolean;
  role: Role;
  lastSeq: number;
  changeSeq: number;
  lastMessageAt: Date | null;
  lastReadSeq: number;
  lastDeliveredSeq: number;
  /** Live text messages from others after the read marker, within the visible window; capped at 1000. */
  unread: number;
  /** The newest message the user can see here (a tombstone has body null). */
  lastMessage: { seq: number; senderId: string | null; kind: 'text' | 'system'; body: string | null; meta: Record<string, unknown> | null; deletedAt: Date | null; createdAt: Date } | null;
};

export const UNREAD_CAP = 1000;

/**
 * Unread, per SCHEMA.md decision 3: live text messages from others after the read marker, within
 * the latest membership window. Expects aliases c (conversation), p (latest period) and r (marker).
 */
const unreadSql = (userParam: string) => `(SELECT count(*)::int FROM (
  SELECT 1 FROM messages x
   WHERE x.conversation_id = c.id AND x.seq > r.last_read_seq
     AND (p.left_seq IS NULL OR x.seq <= p.left_seq)
     AND x.kind = 'text' AND x.deleted_at IS NULL AND x.sender_id <> ${userParam}
   LIMIT ${String(UNREAD_CAP)}) s)`;

/** Every conversation the user can read (active or read-only), most recent activity first. */
export async function listConversations(pool: pg.Pool, userId: string, limit = 50): Promise<InboxEntry[]> {
  const { rows } = await pool.query<InboxEntry & { peer_id: string | null; peer_handle: string | null; peer_name: string | null; peer_deleted: boolean | null }>(
    `SELECT c.id, c.kind, c.title, c.last_seq AS "lastSeq", c.change_seq AS "changeSeq", c.last_message_at AS "lastMessageAt",
            p.left_at IS NULL AS active, p.role,
            r.last_read_seq AS "lastReadSeq", r.last_delivered_seq AS "lastDeliveredSeq",
            ${unreadSql('$1')} AS unread,
            peer.id AS peer_id, peer.handle AS peer_handle, peer.display_name AS peer_name, peer.deleted_at IS NOT NULL AS peer_deleted,
            (SELECT json_build_object('seq', x.seq, 'senderId', x.sender_id, 'kind', x.kind, 'body', x.body,
                                      'meta', x.meta, 'deletedAt', x.deleted_at, 'createdAt', x.created_at)
               FROM messages x
              WHERE x.conversation_id = c.id AND x.seq >= p.joined_seq AND x.seq <= COALESCE(p.left_seq, c.last_seq)
              ORDER BY x.seq DESC LIMIT 1) AS "lastMessage"
       FROM (SELECT DISTINCT ON (conversation_id) * FROM conversation_memberships
              WHERE user_id = $1 ORDER BY conversation_id, joined_seq DESC) p
       JOIN conversations c ON c.id = p.conversation_id
       JOIN read_markers r ON r.conversation_id = c.id AND r.user_id = $1
       LEFT JOIN direct_conversations d ON d.conversation_id = c.id
       LEFT JOIN users peer ON peer.id = CASE WHEN d.user_lo = $1 THEN d.user_hi ELSE d.user_lo END
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map(({ peer_id, peer_handle, peer_name, peer_deleted, ...e }) => ({
    ...e,
    peer: peer_id && peer_handle ? { id: peer_id, handle: peer_handle, displayName: peer_name ?? peer_handle, deleted: peer_deleted === true } : null,
  }));
}

/** Unread count for one conversation (same definition as the inbox). 404 for non-members. */
export async function unreadCount(pool: pg.Pool, conversationId: string, userId: string): Promise<number> {
  assertUuid(conversationId, 'Conversation');
  const { rows: [row] } = await pool.query<{ unread: number }>(
    `SELECT ${unreadSql('$2')} AS unread
       FROM (SELECT * FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2
              ORDER BY joined_seq DESC LIMIT 1) p
       JOIN conversations c ON c.id = p.conversation_id
       JOIN read_markers r ON r.conversation_id = c.id AND r.user_id = $2`,
    [conversationId, userId],
  );
  if (!row) throw notFound();
  return row.unread;
}

export type Member = {
  userId: string;
  handle: string;
  displayName: string;
  role: Role;
  /** The latest membership period. */
  joinedSeq: number;
  leftSeq: number | null;
  active: boolean;
  lastReadSeq: number;
  lastDeliveredSeq: number;
  /** The account was deleted ("Deleted user"); its DMs take no new messages. */
  deleted: boolean;
};

export type ConversationDetail = Conversation & {
  lastSeq: number;
  changeSeq: number;
  /** The caller's role, or null when they can only read (former member). */
  myRole: Role | null;
  members: Member[];
  /** Direct conversations: whether a block stops messages here (and whose). Always null for groups. */
  block: BlockState;
};

/**
 * One conversation with its members and their read/delivered markers (for ticks, the member list
 * and group management). Readable by anyone with a membership period; 404 otherwise.
 */
export async function getConversation(pool: pg.Pool, conversationId: string, userId: string): Promise<ConversationDetail> {
  assertUuid(conversationId, 'Conversation');
  const access = await accessOf(pool, conversationId, userId);
  if (!access) throw notFound();
  const { rows: [conv] } = await pool.query<Conversation & { lastSeq: number; changeSeq: number }>(
    `SELECT ${CONV_COLUMNS}, c.last_seq AS "lastSeq", c.change_seq AS "changeSeq" FROM conversations c WHERE c.id = $1`, [conversationId],
  );
  if (!conv) throw notFound();
  const { rows: members } = await pool.query<Member>(
    `SELECT u.id AS "userId", u.handle, u.display_name AS "displayName", p.role, p.joined_seq AS "joinedSeq",
            p.left_seq AS "leftSeq", p.left_at IS NULL AS active,
            r.last_read_seq AS "lastReadSeq", r.last_delivered_seq AS "lastDeliveredSeq", u.deleted_at IS NOT NULL AS deleted
       FROM (SELECT DISTINCT ON (user_id) * FROM conversation_memberships
              WHERE conversation_id = $1 ORDER BY user_id, joined_seq DESC) p
       JOIN users u ON u.id = p.user_id
       JOIN read_markers r ON r.conversation_id = p.conversation_id AND r.user_id = p.user_id
      ORDER BY p.left_at IS NULL DESC, CASE p.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.handle)`,
    [conversationId],
  );
  const peer = conv.kind === 'direct' ? members.find((m) => m.userId !== userId) : undefined;
  return { ...conv, myRole: access.activeRole, members, block: peer ? await blockState(pool, userId, peer.userId) : null };
}
