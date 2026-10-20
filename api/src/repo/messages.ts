import { createHash } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../errors.js';
import { assertUuid, readOnly, requireActive, requireReader, visibleTo } from './access.js';
import { isUniqueViolation, violates, withTx } from './pg.js';
import { codePointLength } from './text.js';

export type Message = {
  id: string;
  conversationId: string;
  seq: number;
  /** Value of the conversation's change cursor at this row's latest insert, edit or delete. */
  changeSeq: number;
  senderId: string | null;
  clientMsgId: string | null;
  kind: 'text' | 'system';
  /** NULL for system messages and for tombstones (deleted for everyone). */
  body: string | null;
  meta: Record<string, unknown> | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
};

export const MAX_BODY_CHARS = 4000;
export const MAX_PAGE = 200;

export const MSG_COLUMNS = `m.id, m.conversation_id AS "conversationId", m.seq, m.updated_change_seq AS "changeSeq",
  m.sender_id AS "senderId", m.client_msg_id AS "clientMsgId", m.kind, m.body, m.meta,
  m.created_at AS "createdAt", m.edited_at AS "editedAt", m.deleted_at AS "deletedAt"`;

/** Same rule as the messages_live_text constraint: 1–4000 code points, not blank. */
function validateBody(body: unknown): string {
  if (typeof body !== 'string') throw new HttpError(400, 'invalid_request', 'Message body must be text');
  const chars = codePointLength(body);
  if (chars < 1 || chars > MAX_BODY_CHARS || body.trim() === '') {
    throw new HttpError(400, 'invalid_request', `Messages are 1–${String(MAX_BODY_CHARS)} characters and not blank`);
  }
  return body;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const pageLimit = (limit: number) => Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_PAGE);

export type SendInput = { conversationId: string; senderId: string; clientMsgId: string; body: string };
export type SendResult = { message: Message; duplicate: boolean };

/**
 * Idempotent send. The (sender, client message id) pair identifies a send:
 *   - a retry with the same id, conversation and body returns the original (duplicate: true);
 *   - the same id with a different body or conversation is rejected (409 idempotency_conflict);
 *   - a retry of a send that was since deleted for everyone returns the tombstone.
 * The insert and the sender's read-marker bump commit together; seq is assigned by the DB
 * trigger. A concurrent duplicate fails on messages_sender_client_key, its transaction (seq
 * increment included) rolls back, and the original is returned, so there is never a gap.
 */
export async function sendMessage(pool: pg.Pool, input: SendInput): Promise<SendResult> {
  assertUuid(input.conversationId, 'Conversation');
  assertUuid(input.clientMsgId, 'clientMsgId', 400);
  const body = validateBody(input.body);
  const hash = sha256(body);

  const resolveExisting = async (): Promise<SendResult | undefined> => {
    const { rows: [row] } = await pool.query<Message & { hash: Buffer | null }>(
      `SELECT ${MSG_COLUMNS}, m.send_body_sha256 AS hash FROM messages m WHERE m.sender_id = $1 AND m.client_msg_id = $2`,
      [input.senderId, input.clientMsgId],
    );
    if (!row) return undefined;
    const { hash: stored, ...message } = row;
    const sameSend = message.conversationId === input.conversationId && (message.deletedAt !== null || (stored !== null && stored.equals(hash)));
    if (!sameSend) {
      throw new HttpError(409, 'idempotency_conflict', 'This client message id was already used for a different message');
    }
    return { message, duplicate: true };
  };

  const existing = await resolveExisting();
  if (existing) return existing;
  await requireActive(pool, input.conversationId, input.senderId);

  try {
    const message = await withTx(pool, async (tx) => {
      const { rows: [row] } = await tx.query<Message>(
        `INSERT INTO messages AS m (conversation_id, sender_id, client_msg_id, send_body_sha256, kind, body)
         VALUES ($1, $2, $3, $4, 'text', $5) RETURNING ${MSG_COLUMNS}`,
        [input.conversationId, input.senderId, input.clientMsgId, hash, body],
      );
      if (!row) throw new Error('insert returned no row');
      // Decision 3: your own message marks everything up to it as read (and delivered).
      await tx.query(
        `UPDATE read_markers SET last_read_seq = GREATEST(last_read_seq, $3), last_delivered_seq = GREATEST(last_delivered_seq, $3)
          WHERE conversation_id = $1 AND user_id = $2`,
        [input.conversationId, input.senderId, row.seq],
      );
      return row;
    });
    return { message, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err, 'messages_sender_client_key')) {
      const original = await resolveExisting();
      if (original) return original;
    }
    // Removed between the access check and the insert: the trigger re-checks under the lock.
    if (violates(err, 'messages_sender_active_member')) throw readOnly();
    throw err;
  }
}

/** Explains why an edit/delete matched no row, in the order a client can act on. */
async function explainMiss(pool: pg.Pool, conversationId: string, messageId: string, userId: string): Promise<never> {
  const { rows: [m] } = await pool.query<{ conversation_id: string; sender_id: string | null; kind: string; deleted_at: Date | null; visible: boolean }>(
    `SELECT m.conversation_id, m.sender_id, m.kind, m.deleted_at, ${visibleTo('$2')} AS visible FROM messages m WHERE m.id = $1 AND m.conversation_id = $3`,
    [messageId, userId, conversationId],
  );
  if (!m?.visible) throw new HttpError(404, 'not_found', 'Message not found');
  if (m.sender_id !== userId || m.kind !== 'text') throw new HttpError(403, 'forbidden', 'You can only change your own messages');
  if (m.deleted_at) throw new HttpError(409, 'message_deleted', 'This message was deleted');
  throw readOnly();
}

/** Sender-only edit of a live text message, while an active member. Takes a new change cursor value. */
export async function editMessage(pool: pg.Pool, input: { conversationId: string; messageId: string; userId: string; body: string }): Promise<Message> {
  assertUuid(input.conversationId, 'Conversation');
  assertUuid(input.messageId, 'Message');
  const body = validateBody(input.body);
  const { rows: [row] } = await pool.query<Message>(
    `UPDATE messages m SET body = $3
      WHERE m.id = $1 AND m.sender_id = $2 AND m.conversation_id = $4 AND m.kind = 'text' AND m.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM conversation_memberships p
                     WHERE p.conversation_id = m.conversation_id AND p.user_id = $2 AND p.left_at IS NULL)
      RETURNING ${MSG_COLUMNS}`,
    [input.messageId, input.userId, body, input.conversationId],
  );
  return row ?? explainMiss(pool, input.conversationId, input.messageId, input.userId);
}

/**
 * Delete for everyone: the row and its seq stay; the trigger erases body and body hash. Only the
 * sender may do it, and still may after leaving (erasing your own words is never blocked).
 * Idempotent: deleting a tombstone returns it.
 */
export async function deleteForEveryone(pool: pg.Pool, input: { conversationId: string; messageId: string; userId: string }): Promise<Message> {
  assertUuid(input.conversationId, 'Conversation');
  assertUuid(input.messageId, 'Message');
  const { rows: [row] } = await pool.query<Message>(
    `UPDATE messages m SET deleted_at = now()
      WHERE m.id = $1 AND m.sender_id = $2 AND m.conversation_id = $3 AND m.kind = 'text' AND m.deleted_at IS NULL
      RETURNING ${MSG_COLUMNS}`,
    [input.messageId, input.userId, input.conversationId],
  );
  if (row) return row;
  const { rows: [tombstone] } = await pool.query<Message>(
    `SELECT ${MSG_COLUMNS} FROM messages m WHERE m.id = $1 AND m.sender_id = $2 AND m.conversation_id = $3 AND m.deleted_at IS NOT NULL`,
    [input.messageId, input.userId, input.conversationId],
  );
  return tombstone ?? explainMiss(pool, input.conversationId, input.messageId, input.userId);
}

export type Markers = { lastReadSeq: number; lastDeliveredSeq: number };

/**
 * Moves the read (and therefore delivered) marker forward to `seq`, clamped to the highest seq the
 * user can see. Never moves backwards and never errors on a stale or too-large seq.
 */
export async function markRead(pool: pg.Pool, input: { conversationId: string; userId: string; seq: number }): Promise<Markers> {
  return advanceMarkers(pool, input, true);
}

/** Moves only the delivered marker forward (the client received the messages but hasn't shown them). */
export async function markDelivered(pool: pg.Pool, input: { conversationId: string; userId: string; seq: number }): Promise<Markers> {
  return advanceMarkers(pool, input, false);
}

async function advanceMarkers(pool: pg.Pool, input: { conversationId: string; userId: string; seq: number }, read: boolean): Promise<Markers> {
  assertUuid(input.conversationId, 'Conversation');
  if (!Number.isSafeInteger(input.seq) || input.seq < 0) throw new HttpError(400, 'invalid_request', 'seq must be a non-negative integer');
  const { rows: [row] } = await pool.query<Markers>(
    `UPDATE read_markers r
        SET last_delivered_seq = GREATEST(r.last_delivered_seq, LEAST($3::bigint, cap.v))
            ${read ? ', last_read_seq = GREATEST(r.last_read_seq, LEAST($3::bigint, cap.v))' : ''}
       FROM (SELECT max(COALESCE(p.left_seq, c.last_seq)) AS v
               FROM conversation_memberships p JOIN conversations c ON c.id = p.conversation_id
              WHERE p.conversation_id = $1 AND p.user_id = $2) cap
      WHERE r.conversation_id = $1 AND r.user_id = $2 AND cap.v IS NOT NULL
      RETURNING r.last_read_seq AS "lastReadSeq", r.last_delivered_seq AS "lastDeliveredSeq"`,
    [input.conversationId, input.userId, input.seq],
  );
  if (!row) throw new HttpError(404, 'not_found', 'Conversation not found');
  return row;
}

export type Page = { messages: Message[]; hasMore: boolean };

/** One page of history before `beforeSeq` (newest first in the query, returned oldest first). */
export async function history(pool: pg.Pool, input: { conversationId: string; userId: string; beforeSeq?: number; limit?: number }): Promise<Page> {
  assertUuid(input.conversationId, 'Conversation');
  await requireReader(pool, input.conversationId, input.userId);
  const limit = pageLimit(input.limit ?? 50);
  const { rows } = await pool.query<Message>(
    `SELECT ${MSG_COLUMNS} FROM messages m
      WHERE m.conversation_id = $1 AND m.seq < $3 AND ${visibleTo('$2')}
      ORDER BY m.seq DESC LIMIT $4`,
    [input.conversationId, input.userId, input.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1],
  );
  return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

/** Messages after `afterSeq` in seq order: gap repair after reconnect. */
export async function catchUpBySeq(pool: pg.Pool, input: { conversationId: string; userId: string; afterSeq: number; limit?: number }): Promise<Page> {
  assertUuid(input.conversationId, 'Conversation');
  await requireReader(pool, input.conversationId, input.userId);
  const limit = pageLimit(input.limit ?? MAX_PAGE);
  const { rows } = await pool.query<Message>(
    `SELECT ${MSG_COLUMNS} FROM messages m
      WHERE m.conversation_id = $1 AND m.seq > $3 AND ${visibleTo('$2')}
      ORDER BY m.seq LIMIT $4`,
    [input.conversationId, input.userId, input.afterSeq, limit + 1],
  );
  return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
}

export type ChangePage = Page & { nextCursor: number };

/**
 * Every visible row whose latest insert, edit or delete came after `afterChange`, in change order.
 * `nextCursor` is the last row's changeSeq when the page is full, else the conversation's
 * change_seq read in the same statement (changes outside the user's windows are skipped). The
 * conversation row lock makes change values commit in order, so a cursor never skips one.
 */
export async function catchUpByChange(pool: pg.Pool, input: { conversationId: string; userId: string; afterChange: number; limit?: number }): Promise<ChangePage> {
  assertUuid(input.conversationId, 'Conversation');
  await requireReader(pool, input.conversationId, input.userId);
  const limit = pageLimit(input.limit ?? MAX_PAGE);
  const { rows } = await pool.query<{ conv_change: number; msg: Message | null }>(
    `SELECT c.change_seq AS conv_change, page.msg
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT to_jsonb(x) AS msg, x."changeSeq" FROM (
           SELECT ${MSG_COLUMNS} FROM messages m
            WHERE m.conversation_id = c.id AND m.updated_change_seq > $3 AND ${visibleTo('$2')}
            ORDER BY m.updated_change_seq LIMIT $4) x
       ) page ON true
      WHERE c.id = $1
      ORDER BY page."changeSeq"`,
    [input.conversationId, input.userId, input.afterChange, limit + 1],
  );
  const convChange = rows[0]?.conv_change ?? input.afterChange;
  const messages = rows.flatMap((r) => (r.msg ? [reviveDates(r.msg)] : []));
  const hasMore = messages.length > limit;
  const page = messages.slice(0, limit);
  const nextCursor = hasMore ? (page.at(-1)?.changeSeq ?? input.afterChange) : Math.max(convChange, input.afterChange);
  return { messages: page, hasMore, nextCursor };
}

/** to_jsonb turns timestamps into strings; bring them back to Date like the other queries. */
function reviveDates(m: Message): Message {
  const d = (v: Date | string | null) => (v === null ? null : new Date(v));
  return { ...m, createdAt: new Date(m.createdAt), editedAt: d(m.editedAt), deletedAt: d(m.deletedAt) };
}

export type Receipt = { userId: string; handle: string; displayName: string; deliveredAt: Date | null; readAt: Date | null };

/**
 * Who received and read one of your messages, and when (the group "message info" panel). Only the
 * sender may ask. Recipients are everyone else whose membership window contains the message's seq;
 * times come from marker_events (the first move of each marker past the seq).
 */
export async function messageReceipts(pool: pg.Pool, input: { conversationId: string; messageId: string; userId: string }): Promise<Receipt[]> {
  assertUuid(input.conversationId, 'Conversation');
  assertUuid(input.messageId, 'Message');
  await requireReader(pool, input.conversationId, input.userId);
  const { rows: [m] } = await pool.query<{ seq: number; sender_id: string | null }>(
    'SELECT seq, sender_id FROM messages WHERE id = $1 AND conversation_id = $2', [input.messageId, input.conversationId],
  );
  if (!m) throw new HttpError(404, 'not_found', 'Message not found');
  if (m.sender_id !== input.userId) throw new HttpError(403, 'forbidden', 'Only the sender can see who read a message');
  const { rows } = await pool.query<Receipt>(
    `SELECT u.id AS "userId", u.handle, u.display_name AS "displayName",
            (SELECT min(e.at) FROM marker_events e WHERE e.conversation_id = $1 AND e.user_id = u.id
                AND e.kind = 'delivered' AND e.upto_seq >= $2) AS "deliveredAt",
            (SELECT min(e.at) FROM marker_events e WHERE e.conversation_id = $1 AND e.user_id = u.id
                AND e.kind = 'read' AND e.upto_seq >= $2) AS "readAt"
       FROM users u
      WHERE u.id <> $3 AND u.id IN (
        SELECT p.user_id FROM conversation_memberships p
         WHERE p.conversation_id = $1 AND p.joined_seq <= $2 AND (p.left_seq IS NULL OR p.left_seq >= $2))
      ORDER BY lower(u.display_name)`,
    [input.conversationId, m.seq, input.userId],
  );
  return rows;
}
