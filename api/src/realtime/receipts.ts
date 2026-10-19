import type pg from 'pg';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { markDelivered } from '../repo/messages.js';
import { CONV_CHANNEL } from './fanout.js';
import { userRoom, type InboundHandler, type Realtime } from './server.js';

export type ReceiptEvent = { conversationId: string; userId: string; seq: number };

const deliveredPayload = z.object({ conversationId: z.uuid(), seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

const isString = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/**
 * Inbound `delivered` {conversationId, seq}: the client stored everything up to seq. The
 * delivered marker moves forward only and is clamped to what the user can see (markDelivered);
 * the database then signals the change like any other marker move.
 */
export function deliveredHandler(pool: pg.Pool): InboundHandler {
  return async (socket, payload, ack) => {
    const parsed = deliveredPayload.safeParse(payload);
    if (!parsed.success) {
      socket.disconnect(true); // a protocol violation, not a user error
      return;
    }
    try {
      const markers = await markDelivered(pool, { ...parsed.data, userId: socket.data.userId });
      ack?.({ ok: true, ...markers });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      ack?.({ ok: false, code: err.code });
    }
  };
}

/**
 * read:updated / delivered:updated fan-out. Receipts go to the reader's own tabs (to clear their
 * badges) and to the conversation's other active members. Former members get no receipts: they
 * may read the past, not watch the present.
 */
export function attachReceipts(realtime: Realtime, pool: pg.Pool): void {
  realtime.onChannel(CONV_CHANNEL, async (p) => {
    if (p.kind !== 'markers') return;
    if (!isString(p.conversation_id) || !isString(p.user_id) || !isInt(p.read_seq) || !isInt(p.delivered_seq)) return;
    const { rows } = await pool.query<{ user_id: string }>(
      'SELECT DISTINCT user_id FROM conversation_memberships WHERE conversation_id = $1 AND left_at IS NULL', [p.conversation_id],
    );
    const rooms = [...new Set([p.user_id, ...rows.map((r) => r.user_id)])].map(userRoom);
    const base = { conversationId: p.conversation_id, userId: p.user_id };
    if (p.read_moved === true) realtime.io.to(rooms).emit('read:updated', { ...base, seq: p.read_seq } satisfies ReceiptEvent);
    if (p.delivered_moved === true) realtime.io.to(rooms).emit('delivered:updated', { ...base, seq: p.delivered_seq } satisfies ReceiptEvent);
  });
}
