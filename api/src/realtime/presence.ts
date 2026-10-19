import type pg from 'pg';
import type { Logger } from 'pino';
import { userRoom, type ChitthiSocket, type Realtime } from './server.js';

export type PresenceEvent = { userId: string; online: boolean; lastSeenAt: string | null };
export type PresenceTuning = { graceMs: number };
export const DEFAULT_PRESENCE: PresenceTuning = { graceMs: 10_000 };

/**
 * Presence for a single API instance (docs/REALTIME.md covers what a second instance needs).
 *
 * - A user is online while they have at least one socket. Tabs and devices are counted, so
 *   closing one of two tabs changes nothing.
 * - Going offline waits `graceMs` with zero sockets, so a reload or a flaky network doesn't
 *   flicker. Reconnecting within the grace cancels it silently.
 * - On going offline, users.last_seen_at is persisted.
 * - Presence is visible only to users who share an active conversation: events go only to their
 *   user rooms, and each new socket gets a snapshot of exactly those users.
 */
export function attachPresence(realtime: Realtime, pool: pg.Pool, logger: Logger, tuning: PresenceTuning = DEFAULT_PRESENCE) {
  const sockets = new Map<string, Set<string>>();
  const pendingOffline = new Map<string, NodeJS.Timeout>();

  async function coMembers(userId: string): Promise<string[]> {
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT DISTINCT p2.user_id
         FROM conversation_memberships p1
         JOIN conversation_memberships p2
           ON p2.conversation_id = p1.conversation_id AND p2.left_at IS NULL AND p2.user_id <> p1.user_id
        WHERE p1.user_id = $1 AND p1.left_at IS NULL`,
      [userId],
    );
    return rows.map((r) => r.user_id);
  }

  async function announce(event: PresenceEvent): Promise<void> {
    const rooms = (await coMembers(event.userId)).map(userRoom);
    if (rooms.length > 0) realtime.io.to(rooms).emit('presence', event);
  }

  async function goOffline(userId: string): Promise<void> {
    pendingOffline.delete(userId);
    if ((sockets.get(userId)?.size ?? 0) > 0) return; // came back
    sockets.delete(userId);
    const { rows: [row] } = await pool.query<{ last_seen_at: Date }>(
      'UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at', [userId],
    );
    await announce({ userId, online: false, lastSeenAt: row?.last_seen_at.toISOString() ?? null });
  }

  async function ready(socket: ChitthiSocket): Promise<void> {
    const userId = socket.data.userId;
    const mine = sockets.get(userId) ?? new Set<string>();
    const wasOnline = mine.size > 0 || pendingOffline.has(userId);
    mine.add(socket.id);
    sockets.set(userId, mine);
    const pending = pendingOffline.get(userId);
    if (pending) {
      clearTimeout(pending);
      pendingOffline.delete(userId);
    }
    if (!wasOnline) await announce({ userId, online: true, lastSeenAt: null });

    // Snapshot of everyone this user may see.
    const others = await coMembers(userId);
    const { rows } = await pool.query<{ id: string; last_seen_at: Date | null }>(
      'SELECT id, last_seen_at FROM users WHERE id = ANY($1::uuid[])', [others],
    );
    const snapshot: PresenceEvent[] = rows.map((r) => {
      const online = (sockets.get(r.id)?.size ?? 0) > 0 || pendingOffline.has(r.id);
      return { userId: r.id, online, lastSeenAt: online ? null : (r.last_seen_at?.toISOString() ?? null) };
    });
    socket.emit('presence:snapshot', { users: snapshot });
  }

  function gone(socket: ChitthiSocket): void {
    const userId = socket.data.userId;
    const mine = sockets.get(userId);
    if (!mine) return;
    mine.delete(socket.id);
    if (mine.size > 0 || pendingOffline.has(userId)) return;
    pendingOffline.set(userId, setTimeout(() => {
      goOffline(userId).catch((err: unknown) => { logger.error({ err }, 'presence offline failed'); });
    }, tuning.graceMs));
  }

  realtime.onSocket({ ready, gone });

  return {
    isOnline: (userId: string) => (sockets.get(userId)?.size ?? 0) > 0 || pendingOffline.has(userId),
    /** Shutdown: everyone still counted as online was last seen now. */
    async flush(): Promise<void> {
      for (const t of pendingOffline.values()) clearTimeout(t);
      const users = [...new Set([...sockets.keys(), ...pendingOffline.keys()])];
      pendingOffline.clear();
      sockets.clear();
      if (users.length > 0) await pool.query('UPDATE users SET last_seen_at = now() WHERE id = ANY($1::uuid[])', [users]);
    },
  };
}
