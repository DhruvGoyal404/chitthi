import express, { type Express } from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { meRouter } from './auth.js';
import type { Config } from './config.js';
import { devLoginRouter } from './devLogin.js';
import { errorHandler, notFound } from './errors.js';
import { healthRouter } from './health.js';
import { createRateLimits, limitBy, type RateLimits } from './limits.js';
import { requireAllowedOrigin } from './origin.js';
import { MemorySessionStore, type SessionStore } from './sessions.js';

export type AppDeps = {
  config: Config;
  logger: Logger;
  pool: pg.Pool;
  sessions?: SessionStore;
  rateLimits?: RateLimits;
};

export function createApp({ config, logger, pool, sessions = new MemorySessionStore(), rateLimits = createRateLimits() }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // The API only ever answers with JSON, so its own CSP can forbid everything.
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));

  app.use(pinoHttp({ logger }));
  app.use(requireAllowedOrigin(config.webOrigins));
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(healthRouter(pool));
  // Per client IP on everything that starts or ends a sign-in.
  api.use(['/auth', '/dev/login'], limitBy(rateLimits.auth, (req) => req.ip ?? 'unknown'));
  api.use(meRouter(sessions));
  if (config.devLogin) {
    logger.warn('dev login enabled: anyone can sign in as any handle');
    api.use(devLoginRouter(config.nodeEnv, sessions));
  }
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
