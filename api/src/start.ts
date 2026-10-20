import { createServer, type Server as HttpServer } from 'node:http';
import type pg from 'pg';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import type { Config } from './config.js';
import { createRateLimits, limitsFor, type RateLimits } from './limits.js';
import { attachFanout, CONV_CHANNEL } from './realtime/fanout.js';
import { PgListener, SESSION_CHANNEL } from './realtime/listener.js';
import { attachPresence, DEFAULT_PRESENCE, type PresenceTuning } from './realtime/presence.js';
import { attachReceipts, deliveredHandler } from './realtime/receipts.js';
import { createTyping, DEFAULT_TYPING, type TypingTuning } from './realtime/typing.js';
import { createRealtime, type Realtime, type RealtimeOptions } from './realtime/server.js';

export type Started = {
  httpServer: HttpServer;
  realtime: Realtime;
  listener: PgListener;
  presence: { isOnline(userId: string): boolean };
  /** Base URL actually bound (port 0 → the OS-chosen port). */
  url: string;
  close(): Promise<void>;
};

export type StartOptions = {
  config: Config;
  logger: Logger;
  pool: pg.Pool;
  rateLimits?: RateLimits;
  /** Overrides for tests (inbound rate limit, listener backoff). */
  realtime?: Pick<RealtimeOptions, 'rateLimit'>;
  listenerBackoff?: { minMs: number; maxMs: number };
  /** Timers for ephemeral state (tests shorten them). */
  tuning?: { typing?: TypingTuning; presence?: PresenceTuning };
};

/**
 * The whole API process minus signal handling: HTTP app, Socket.IO on the same server, and the
 * one LISTEN connection. server.ts and the realtime tests both start exactly this.
 */
export async function startApi(opts: StartOptions): Promise<Started> {
  const { config, logger, pool } = opts;
  const rateLimits = opts.rateLimits ?? createRateLimits(pool, logger, limitsFor(config));
  const app = createApp({ config, logger, pool, rateLimits });
  const httpServer = createServer(app);
  const listener = new PgListener(config.databaseUrl, [SESSION_CHANNEL, CONV_CHANNEL], logger, opts.listenerBackoff);
  const typing = createTyping(pool, opts.tuning?.typing ?? DEFAULT_TYPING);
  const realtime = createRealtime({
    httpServer, pool, listener, logger,
    allowedOrigins: config.webOrigins,
    connectLimit: rateLimits.socket,
    // The only events a client may send. Message writes are REST-only.
    inbound: { typing: typing.handler, delivered: deliveredHandler(pool) },
    ...opts.realtime,
  });
  attachFanout(realtime, pool);
  attachReceipts(realtime, pool);
  typing.attach(realtime);
  const presence = attachPresence(realtime, pool, logger, opts.tuning?.presence ?? DEFAULT_PRESENCE);
  // The LISTEN connection retries in the background, so an unreachable database never blocks startup.
  listener.start();

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, resolve);
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  logger.info({ host: config.host, port, nodeEnv: config.nodeEnv }, 'api listening');

  return {
    httpServer, realtime, listener, presence,
    url: `http://${config.host}:${String(port)}`,
    close: async () => {
      // Closing Socket.IO also closes the HTTP server; then stamp last_seen for whoever was online.
      await realtime.close();
      await presence.flush();
      await listener.stop();
    },
  };
}
