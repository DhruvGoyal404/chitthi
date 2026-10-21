import type pg from 'pg';
import { MSG_COLUMNS, type Message } from '../repo/messages.js';
import { traceFanout } from '../timing.js';
import { userRoom, type Realtime } from './server.js';

export const CONV_CHANNEL = 'chitthi_conv';

/** Pushed for a committed new message. `changeSeq` is the change value this event consumed. */
export type MessageEvent = { conversationId: string; seq: number; changeSeq: number; message: Message };

const isString = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/**
 * Message fan-out (docs/REALTIME.md). For each committed insert/edit/delete the database notifies
 * ids only; this reads the row once, together with everyone whose membership window contains its
 * seq, and pushes the row to their user rooms. Windows are fixed once set ([joined_seq, left_seq]
 * are assigned under the conversation lock and never change), so the recipient set for a seq is
 * the same whenever the notification is handled: a removed member gets nothing after left_seq, a
 * new member nothing before joined_seq. The row is read as it is now: if it was deleted for
 * everyone before we read it, the push carries the tombstone, never the erased body.
 */
export function attachFanout(realtime: Realtime, pool: pg.Pool): void {
  const { io } = realtime;

  realtime.onChannel(CONV_CHANNEL, async (p, { receivedAt }) => {
    const kind = p.kind;
    if (kind !== 'message_new' && kind !== 'message_updated') return;
    if (!isString(p.conversation_id) || !isString(p.message_id) || !isInt(p.seq) || !isInt(p.change_seq)) return;
    const startedAt = performance.now();

    const { rows: [row] } = await pool.query<{ message: Message; recipients: string[] }>(
      `SELECT to_jsonb(x) AS message,
              ARRAY(SELECT DISTINCT vp.user_id FROM conversation_memberships vp
                     WHERE vp.conversation_id = $2 AND vp.joined_seq <= $3 AND (vp.left_seq IS NULL OR vp.left_seq >= $3)) AS recipients
         FROM (SELECT ${MSG_COLUMNS} FROM messages m WHERE m.id = $1) x`,
      [p.message_id, p.conversation_id, p.seq],
    );
    if (!row || row.recipients.length === 0) return;
    const readAt = performance.now();
    const event: MessageEvent = { conversationId: p.conversation_id, seq: p.seq, changeSeq: p.change_seq, message: row.message };
    io.to(row.recipients.map(userRoom)).emit(kind === 'message_new' ? 'message:new' : 'message:updated', event);
    if (kind === 'message_new') traceFanout(p.message_id, { receivedAt, startedAt, readAt, emittedAt: performance.now() });
  });

  // Notifications sent while the listener was down are gone: every client catches up over REST.
  realtime.onResync(() => {
    io.emit('resync');
    return Promise.resolve();
  });
}
