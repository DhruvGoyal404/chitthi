import type { Server as HttpServer } from 'node:http';
import { parseCookie } from 'cookie';
import type pg from 'pg';
import type { Logger } from 'pino';
import { Server, type DefaultEventsMap, type Socket } from 'socket.io';
import { HttpError } from '../errors.js';
import type { RateLimit } from '../limits.js';
import { SESSION_COOKIE, SessionStore } from '../sessions.js';
import { SESSION_CHANNEL, type PgListener } from './listener.js';

export const SOCKET_PATH = '/api/socket.io';

export type SocketData = { userId: string; sessionId: string };
// Payloads are validated at the edges (zod inbound, repository rows outbound); event maps stay loose.
export type ChitthiSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
export type ChitthiServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

/** An inbound event handler. `ack` is the client's callback, if it sent one. */
export type InboundHandler = (socket: ChitthiSocket, payload: unknown, ack: ((result: unknown) => void) | undefined) => Promise<void>;
/** Handles one notification from a channel, in commit order with every other notification. */
export type ChannelHandler = (payload: Record<string, unknown>) => Promise<void>;

export const userRoom = (userId: string) => `user:${userId}`;
const sessionRoom = (sessionId: string) => `session:${sessionId}`;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Token bucket for inbound events: `burst` at once, refilled at `perSecond`. */
class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly burst: number, private readonly perSecond: number) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export type RealtimeOptions = {
  httpServer: HttpServer;
  pool: pg.Pool;
  listener: PgListener;
  logger: Logger;
  allowedOrigins: readonly string[];
  /** Inbound events per socket. Anything above it disconnects the socket. */
  rateLimit?: { burst: number; perSecond: number };
  /** Connections per user (Postgres limiter); a refused handshake gets `rate_limited`. */
  connectLimit?: RateLimit;
  /** The only inbound events a client may send; any other event disconnects the socket. */
  inbound?: Record<string, InboundHandler>;
};

export type Realtime = {
  io: ChitthiServer;
  /** Adds a handler for a LISTEN channel (the listener must listen on it). */
  onChannel(channel: string, handler: ChannelHandler): void;
  /** Runs after every listener gap, after sockets of ended sessions are dropped. */
  onResync(handler: () => Promise<void>): void;
  /** Called when a socket is ready (rooms joined), and when it disconnects. */
  onSocket(handlers: { ready?: (s: ChitthiSocket) => Promise<void>; gone?: (s: ChitthiSocket) => void }): void;
  /** Resolves when every notification received so far has been handled (tests). */
  idle(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Socket.IO as a push channel (docs/REALTIME.md). The server alone decides rooms: every socket
 * joins exactly `user:<id>` (and `session:<id>`, used only to cut it off). Clients never write
 * messages here; they send at most the few inbound events in `inbound`.
 */
export function createRealtime(opts: RealtimeOptions): Realtime {
  const { pool, listener, logger } = opts;
  const sessions = new SessionStore(pool);
  const allowed = new Set(opts.allowedOrigins);
  const limits = opts.rateLimit ?? { burst: 20, perSecond: 5 };
  const inbound = opts.inbound ?? {};
  const channelHandlers = new Map<string, ChannelHandler[]>();
  const resyncHandlers: (() => Promise<void>)[] = [];
  const readyHandlers: ((s: ChitthiSocket) => Promise<void>)[] = [];
  const goneHandlers: ((s: ChitthiSocket) => void)[] = [];

  const io: ChitthiServer = new Server(opts.httpServer, {
    path: SOCKET_PATH,
    serveClient: false,
    // Inbound events are tiny (typing, delivered-ack); messages never travel client → server here.
    maxHttpBufferSize: 4 * 1024,
    // Exact Origin allow-list on every engine.io request, including the WebSocket upgrade: the
    // defence against cross-site WebSocket hijacking (the session cookie rides along cross-site).
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      const ok = origin !== undefined && allowed.has(origin);
      callback(ok ? null : 'origin not allowed', ok);
    },
  });

  io.use((socket, next) => {
    const token = parseCookie(socket.request.headers.cookie ?? '')[SESSION_COOKIE];
    if (!token) {
      next(new Error('unauthenticated'));
      return;
    }
    sessions.find(token).then(
      async (session) => {
        if (!session) {
          next(new Error('unauthenticated'));
          return;
        }
        try {
          await opts.connectLimit?.(session.user.id);
        } catch (err) {
          next(err instanceof HttpError ? Object.assign(new Error('rate_limited'), { data: err.details }) : new Error('unavailable'));
          return;
        }
        socket.data.userId = session.user.id;
        socket.data.sessionId = session.sessionId;
        // The session ends at expiresAt; so does every socket riding on it.
        const expiresIn = Math.min(session.expiresAt.getTime() - Date.now(), MAX_TIMER_MS);
        const timer = setTimeout(() => socket.disconnect(true), Math.max(0, expiresIn));
        socket.on('disconnect', () => {
          clearTimeout(timer);
        });
        next();
      },
      (err: unknown) => {
        logger.error({ err }, 'socket session lookup failed');
        next(new Error('unavailable'));
      },
    );
  });

  io.on('connection', (socket: ChitthiSocket) => {
    const bucket = new TokenBucket(limits.burst, limits.perSecond);
    socket.onAny((event: string, ...args: unknown[]) => {
      if (!bucket.take()) {
        logger.warn({ userId: socket.data.userId }, 'socket rate limit exceeded; disconnecting');
        socket.disconnect(true);
        return;
      }
      const handler = Object.hasOwn(inbound, event) ? inbound[event] : undefined;
      if (!handler) {
        logger.warn({ userId: socket.data.userId, event }, 'client sent a forbidden event; disconnecting');
        socket.disconnect(true);
        return;
      }
      const last = args.at(-1);
      const ack = typeof last === 'function' ? (last as (r: unknown) => void) : undefined;
      handler(socket, args[0], ack).catch((err: unknown) => {
        logger.error({ err, event }, 'inbound handler failed');
        ack?.({ ok: false, code: 'internal' });
      });
    });
    socket.on('disconnect', () => {
      for (const h of goneHandlers) h(socket);
    });

    void (async () => {
      await socket.join([userRoom(socket.data.userId), sessionRoom(socket.data.sessionId)]);
      for (const h of readyHandlers) await h(socket);
      socket.emit('ready', { userId: socket.data.userId });
    })().catch((err: unknown) => {
      logger.error({ err }, 'socket setup failed');
      socket.disconnect(true);
    });
  });

  // One queue for everything the listener reports, so pushes reach clients in commit order.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (what: string, task: () => Promise<void>) => {
    queue = queue.then(task).catch((err: unknown) => { logger.error({ err }, `realtime ${what} failed`); });
  };

  const onSession = (payload: Record<string, unknown>) => {
    if (typeof payload.session_id === 'string') io.in(sessionRoom(payload.session_id)).disconnectSockets(true);
    if (typeof payload.user_id === 'string') io.in(userRoom(payload.user_id)).disconnectSockets(true);
    return Promise.resolve();
  };
  channelHandlers.set(SESSION_CHANNEL, [onSession]);

  /** After a listener gap: drop sockets whose session ended meanwhile, then let handlers resync. */
  async function resync(): Promise<void> {
    const sockets = await io.fetchSockets();
    const ids = [...new Set(sockets.map((s) => s.data.sessionId))];
    const { rows } = await pool.query<{ id: string }>(
      `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ANY($1::uuid[]) AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [ids],
    );
    const live = new Set(rows.map((r) => r.id));
    for (const s of sockets) if (!live.has(s.data.sessionId)) s.disconnect(true);
    for (const h of resyncHandlers) await h();
  }

  const onNotification = ({ channel, payload }: { channel: string; payload: Record<string, unknown> }) => {
    for (const h of channelHandlers.get(channel) ?? []) enqueue(channel, () => h(payload));
  };
  const onListenerResync = () => { enqueue('resync', resync); };
  listener.on('notification', onNotification);
  listener.on('resync', onListenerResync);

  return {
    io,
    onChannel(channel, handler) {
      channelHandlers.set(channel, [...(channelHandlers.get(channel) ?? []), handler]);
    },
    onResync(handler) {
      resyncHandlers.push(handler);
    },
    onSocket({ ready, gone }) {
      if (ready) readyHandlers.push(ready);
      if (gone) goneHandlers.push(gone);
    },
    idle: () => queue,
    close: async () => {
      listener.off('notification', onNotification);
      listener.off('resync', onListenerResync);
      await new Promise<void>((resolve) => {
        void io.close(() => {
          resolve();
        });
      });
    },
  };
}
