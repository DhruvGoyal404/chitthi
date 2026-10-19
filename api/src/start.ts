import { createServer, type Server as HttpServer } from 'node:http';
import type pg from 'pg';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import type { Config } from './config.js';
import { createRateLimits, type RateLimits } from './limits.js';
import { PgListener, SESSION_CHANNEL } from './realtime/listener.js';
import { createRealtime, type Realtime, type RealtimeOptions } from './realtime/server.js';

export type Started = {
  httpServer: HttpServer;
  realtime: Realtime;
  listener: PgListener;
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
};

/**
 * The whole API process minus signal handling: HTTP app, Socket.IO on the same server, and the
 * one LISTEN connection. server.ts and the realtime tests both start exactly this.
 */
export async function startApi(opts: StartOptions): Promise<Started> {
  const { config, logger, pool } = opts;
  const rateLimits = opts.rateLimits ?? createRateLimits(pool, logger);
  const app = createApp({ config, logger, pool, rateLimits });
  const httpServer = createServer(app);
  const listener = new PgListener(config.databaseUrl, [SESSION_CHANNEL], logger, opts.listenerBackoff);
  const realtime = createRealtime({
    httpServer, pool, listener, logger,
    allowedOrigins: config.webOrigins,
    connectLimit: rateLimits.socket,
    ...opts.realtime,
  });
  // The LISTEN connection retries in the background, so an unreachable database never blocks startup.
  listener.start();

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, resolve);
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  logger.info({ host: config.host, port, nodeEnv: config.nodeEnv }, 'api listening');

  return {
    httpServer, realtime, listener,
    url: `http://${config.host}:${String(port)}`,
    close: async () => {
      // Closing Socket.IO also closes the HTTP server.
      await realtime.close();
      await listener.stop();
    },
  };
}
