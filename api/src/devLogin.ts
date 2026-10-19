import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { devLoginAllowed } from './config.js';
import { findOrCreateDevUser } from './repo/users.js';
import { SESSION_COOKIE, sessionToken, startSession, type SessionStore } from './sessions.js';

const loginBody = z.object({
  handle: z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/, '3–20 characters: letters, digits or _'),
});

/**
 * Sign in as any handle, no password. Development and tests only. The config refuses
 * DEV_LOGIN elsewhere, and constructing this router outside those environments throws, so a
 * misconfigured server fails to start. app.ts also rate-limits it per IP, and the global
 * Origin check applies to its POSTs.
 */
export function devLoginRouter(nodeEnv: string, pool: pg.Pool, store: SessionStore): Router {
  if (!devLoginAllowed(nodeEnv)) {
    throw new Error(`dev login refused: NODE_ENV is "${nodeEnv}"`);
  }
  const router = Router();

  router.post('/dev/login', async (req, res) => {
    const { handle } = loginBody.parse(req.body);
    const user = await findOrCreateDevUser(pool, handle);
    await startSession(store, req, res, user.id, false); // dev and test only: never served over HTTPS
    res.status(201).json({ user: { id: user.id, handle: user.handle } });
  });

  router.post('/dev/logout', async (req, res) => {
    const token = sessionToken(req);
    if (token) await store.revoke(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  return router;
}
