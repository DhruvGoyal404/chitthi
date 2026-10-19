import { Router } from 'express';
import type pg from 'pg';
import { pingDatabase } from './db.js';

export type HealthBody = { status: 'ok' | 'degraded'; db: 'ok' | 'unreachable' };

export function healthRouter(pool: pg.Pool): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    const dbOk = await pingDatabase(pool);
    const body: HealthBody = { status: dbOk ? 'ok' : 'degraded', db: dbOk ? 'ok' : 'unreachable' };
    res.status(dbOk ? 200 : 503).json(body);
  });
  return router;
}
