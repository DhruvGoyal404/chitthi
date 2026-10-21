import type pg from 'pg';
import { z } from 'zod';
import { notBlocked } from '../repo/blocks.js';
import { userRoom, type ChitthiSocket, type InboundHandler, type Realtime } from './server.js';

export type TypingEvent = { conversationId: string; userId: string; typing: boolean; ttlMs: number };
export type TypingTuning = { ttlMs: number; relayIntervalMs: number };
export const DEFAULT_TYPING: TypingTuning = { ttlMs: 5_000, relayIntervalMs: 1_000 };

const typingPayload = z.object({ conversationId: z.uuid(), typing: z.boolean() });

type Entry = { timer: NodeJS.Timeout; lastRelay: number; recipients: string[] };

/**
 * Typing indicators: ephemeral, in memory, never persisted. Every `typing` event is checked
 * against the database (an active membership is required), relayed only to the conversation's
 * other active members with no block either way between them and the typist, at most once per relayIntervalMs per socket and conversation, and
 * expires on its own: no refresh within ttlMs, or the socket going away, relays typing:false.
 */
export function createTyping(pool: pg.Pool, tuning: TypingTuning = DEFAULT_TYPING) {
  const state = new WeakMap<ChitthiSocket, Map<string, Entry>>();
  const entriesOf = (s: ChitthiSocket) => {
    let m = state.get(s);
    if (!m) {
      m = new Map();
      state.set(s, m);
    }
    return m;
  };
  const relay = (socket: ChitthiSocket, conversationId: string, recipients: string[], typing: boolean) => {
    if (recipients.length === 0) return;
    const event: TypingEvent = { conversationId, userId: socket.data.userId, typing, ttlMs: tuning.ttlMs };
    socket.nsp.to(recipients.map(userRoom)).emit('typing', event);
  };
  const stop = (socket: ChitthiSocket, conversationId: string) => {
    const entries = entriesOf(socket);
    const entry = entries.get(conversationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entries.delete(conversationId);
    relay(socket, conversationId, entry.recipients, false);
  };

  const handler: InboundHandler = async (socket, payload, ack) => {
    const parsed = typingPayload.safeParse(payload);
    if (!parsed.success) {
      socket.disconnect(true);
      return;
    }
    const { conversationId, typing } = parsed.data;
    const me = socket.data.userId;
    const { rows: [row] } = await pool.query<{ ever: boolean; active: boolean; others: string[] }>(
      `SELECT EXISTS (SELECT 1 FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2) AS ever,
              EXISTS (SELECT 1 FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL) AS active,
              ARRAY(SELECT DISTINCT user_id FROM conversation_memberships
                     WHERE conversation_id = $1 AND left_at IS NULL AND user_id <> $2
                       AND ${notBlocked('user_id', '$2::uuid')}) AS others`,
      [conversationId, me],
    );
    if (!row?.active) {
      stop(socket, conversationId);
      ack?.({ ok: false, code: row?.ever ? 'read_only' : 'not_found' });
      return;
    }
    if (!typing) {
      stop(socket, conversationId);
      ack?.({ ok: true });
      return;
    }
    const entries = entriesOf(socket);
    const entry = entries.get(conversationId);
    const now = Date.now();
    if (entry) clearTimeout(entry.timer);
    const timer = setTimeout(() => { stop(socket, conversationId); }, tuning.ttlMs);
    if (!entry || now - entry.lastRelay >= tuning.relayIntervalMs) {
      relay(socket, conversationId, row.others, true);
      entries.set(conversationId, { timer, lastRelay: now, recipients: row.others });
    } else {
      entries.set(conversationId, { ...entry, timer, recipients: row.others });
    }
    ack?.({ ok: true });
  };

  return {
    handler,
    attach(realtime: Realtime) {
      realtime.onSocket({
        gone: (socket) => {
          for (const conversationId of [...entriesOf(socket).keys()]) stop(socket, conversationId);
        },
      });
    },
  };
}
