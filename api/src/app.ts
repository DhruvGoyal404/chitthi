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
import { createRateLimits, limitBy, limitsFor, type RateLimits } from './limits.js';
import { LocalStorage, type Storage } from './media/storage.js';
import { downloadsRouter } from './media/downloads.js';
import { imageProcessor } from './media/image.js';
import { purgeDeleted } from './media/lifecycle.js';
import { diskGuard, uploadsRouter } from './media/uploads.js';
import { oauthRouter } from './oauth/router.js';
import { requireAllowedOrigin } from './origin.js';
import { apiRoutes } from './routes.js';
import { SessionStore } from './sessions.js';

export type AppDeps = { config: Config; logger: Logger; pool: pg.Pool; rateLimits?: RateLimits; storage?: Storage };

export function createApp({
  config, logger, pool, rateLimits = createRateLimits(pool, logger, limitsFor(config)), storage = new LocalStorage(config.mediaDir),
}: AppDeps): Express {
  const sessions = new SessionStore(pool);
  const app = express();
  app.disable('x-powered-by');
  // Behind exactly one reverse proxy (Caddy) req.ip is the client from X-Forwarded-For; never more hops.
  app.set('trust proxy', config.trustProxy ? 1 : false);
  // The API only ever answers with JSON, so its own CSP can forbid everything.
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));

  app.use(pinoHttp({ logger }));
  app.use(requireAllowedOrigin(config.webOrigins));
  // No client compresses request bodies. Refusing them (415) also closes GHSA-27r3-jxmh-p828:
  // body-parser ≤ 2.3.0 crashes the process on a compressed body with trailing bytes.
  app.use(express.json({ limit: '100kb', inflate: false }));

  const api = express.Router();
  api.use(healthRouter(pool));
  // Per client IP on everything that starts or completes a sign-in. The read-only listings are
  // exempt: the sign-in and account pages fetch them on every visit.
  api.use(['/auth', '/dev/login', '/dev/pending-signup'], limitBy(rateLimits.auth, (req) =>
    req.method === 'GET' && (req.path === '/providers' || req.path === '/identities') ? undefined : (req.ip ?? 'unknown'),
  ));
  api.use(oauthRouter(pool, sessions, config, logger));
  // After a commit that marked attachments deleted: remove their files now. Never fails the
  // request (the delete already happened); anything left is the sweeper's to retry.
  const purge = (scope: { messageId?: string; uploaderId?: string }) =>
    purgeDeleted(pool, storage, logger, scope).catch((err: unknown) => { logger.warn({ err }, 'post-delete media purge failed; the sweeper will retry'); });
  api.use(meRouter(pool, sessions, purge));
  api.use(uploadsRouter(pool, sessions, storage, rateLimits, logger, diskGuard(storage, logger, config.diskGuard), imageProcessor(config.images)));
  api.use(downloadsRouter(pool, sessions, storage, logger));
  api.use(apiRoutes(pool, sessions, rateLimits, purge));
  if (config.devLogin) {
    logger.warn('dev login enabled: anyone can sign in as any handle');
    api.use(devLoginRouter(config.nodeEnv, pool, sessions));
  }
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
