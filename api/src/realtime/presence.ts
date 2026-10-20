import type pg from 'pg';
import type { Logger } from 'pino';
import { CONV_CHANNEL } from './fanout.js';
import { userRoom, type ChitthiSocket, type Realtime } from './server.js';

export type PresenceEvent = { userId: string; online: boolean; lastSeenAt: string | null };
export type PresenceTuning = { graceMs: number };
export const DEFAULT_PRESENCE: PresenceTuning = { graceMs: 10_000 };
/** Joins committed within this window are introduced together (a DM or group creation is one batch). */
const INTRO_BATCH_MS = 25;

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
 * - When a membership starts (DM created, group created, member added), the new member and the
 *   conversation's other active members are sent each other's presence at once, so nobody has
 *   to reconnect to see a new contact's status.
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

  const online = (id: string) => (sockets.get(id)?.size ?? 0) > 0 || pendingOffline.has(id);

  /** Current presence of `ids`, exactly as snapshots and the membership exchange report it. */
  async function presenceOf(ids: string[]): Promise<PresenceEvent[]> {
    if (ids.length === 0) return [];
    const { rows } = await pool.query<{ id: string; last_seen_at: Date | null }>(
      'SELECT id, last_seen_at FROM users WHERE id = ANY($1::uuid[])', [ids],
    );
    return rows.map((r) => {
      const on = online(r.id);
      return { userId: r.id, online: on, lastSeenAt: on ? null : (r.last_seen_at?.toISOString() ?? null) };
    });
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
    socket.emit('presence:snapshot', { users: await presenceOf(await coMembers(userId)) });
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

  // A membership started: introduce the new members and the other active members to each other.
  // Deliberately NOT done inside the ordered queue (presence needn't be ordered with messages, and a
  // 100-member group creation would otherwise hold message fan-out back by seconds). Joins are
  // coalesced per conversation for INTRO_BATCH_MS, so one creation costs two queries in total, and
  // each recipient gets a single presence:update with every user it should learn about.
  const pendingJoins = new Map<string, Set<string>>();
  let flushTimer: NodeJS.Timeout | undefined;

  async function introduce(conversationId: string, joiners: Set<string>): Promise<void> {
    const { rows } = await pool.query<{ user_id: string }>(
      'SELECT DISTINCT user_id FROM conversation_memberships WHERE conversation_id = $1 AND left_at IS NULL',
      [conversationId],
    );
    const members = rows.map((r) => r.user_id);
    if (members.length < 2) return;
    const byId = new Map((await presenceOf(members)).map((e) => [e.userId, e]));
    const of = (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? []);
    // Each joiner learns about every other member; existing members learn about the joiners.
    for (const j of joiners) {
      const users = of(members.filter((m) => m !== j));
      if (users.length > 0) realtime.io.to(userRoom(j)).emit('presence:update', { users });
    }
    const existing = members.filter((m) => !joiners.has(m));
    const joined = of([...joiners]);
    if (existing.length > 0 && joined.length > 0) realtime.io.to(existing.map(userRoom)).emit('presence:update', { users: joined });
  }

  function flushJoins(): void {
    flushTimer = undefined;
    const batch = [...pendingJoins];
    pendingJoins.clear();
    for (const [conversationId, joiners] of batch) {
      introduce(conversationId, joiners).catch((err: unknown) => { logger.error({ err }, 'presence introduction failed'); });
    }
  }

  realtime.onChannel(CONV_CHANNEL, (p) => {
    if (p.kind !== 'member_joined' || typeof p.conversation_id !== 'string' || typeof p.user_id !== 'string') return Promise.resolve();
    const set = pendingJoins.get(p.conversation_id) ?? new Set<string>();
    set.add(p.user_id);
    pendingJoins.set(p.conversation_id, set);
    flushTimer ??= setTimeout(flushJoins, INTRO_BATCH_MS);
    return Promise.resolve();
  });

  return {
    isOnline: online,
    /** Shutdown: everyone still counted as online was last seen now. */
    async flush(): Promise<void> {
      clearTimeout(flushTimer);
      pendingJoins.clear();
      for (const t of pendingOffline.values()) clearTimeout(t);
      const users = [...new Set([...sockets.keys(), ...pendingOffline.keys()])];
      pendingOffline.clear();
      sockets.clear();
      if (users.length > 0) await pool.query('UPDATE users SET last_seen_at = now() WHERE id = ANY($1::uuid[])', [users]);
    },
  };
}
