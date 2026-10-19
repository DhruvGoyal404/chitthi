import express, { type Express } from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.js';
import { errorHandler, notFound } from './errors.js';
import { healthRouter } from './health.js';
import { requireAllowedOrigin } from './origin.js';

export type AppDeps = { config: Config; logger: Logger; pool: pg.Pool };

export function createApp({ config, logger, pool }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // The API only ever answers with JSON, so its own CSP can forbid everything.
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));

  app.use(pinoHttp({ logger }));
  app.use(requireAllowedOrigin(config.webOrigins));
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(healthRouter(pool));
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
