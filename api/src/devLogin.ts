import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { devLoginAllowed } from './config.js';
import { SESSION_COOKIE, sessionToken, startSession, type SessionStore } from './sessions.js';

const loginBody = z.object({
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,20}$/, '3–20 characters: a–z, 0–9 or _'),
});

/**
 * The same handle always maps to the same id, so dev users stay stable across restarts until
 * the users table exists. The UUID is derived (v8 layout) from a hash of the handle.
 */
export function devUserId(handle: string): string {
  const h = createHash('sha256').update(`chitthi-dev:${handle}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Sign in as any handle, no password. Development and tests only. The config refuses
 * DEV_LOGIN elsewhere, and constructing this router outside those environments throws, so a
 * misconfigured server fails to start. app.ts also rate-limits it per IP, and the global
 * Origin check applies to its POSTs.
 */
export function devLoginRouter(nodeEnv: string, store: SessionStore): Router {
  if (!devLoginAllowed(nodeEnv)) {
    throw new Error(`dev login refused: NODE_ENV is "${nodeEnv}"`);
  }
  const router = Router();

  router.post('/dev/login', async (req, res) => {
    const { handle } = loginBody.parse(req.body);
    const user = { id: devUserId(handle), handle };
    await startSession(store, req, res, user, false); // dev and test only: never served over HTTPS
    res.status(201).json({ user });
  });

  router.post('/dev/logout', async (req, res) => {
    const token = sessionToken(req);
    if (token) await store.revoke(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  return router;
}
