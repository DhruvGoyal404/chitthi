import { Router, type RequestHandler, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { HttpError } from './errors.js';
import { getUser, updateProfile } from './repo/users.js';
import { sessionToken, type Session, type SessionStore } from './sessions.js';

/** 401 unless the request carries a live session cookie; the session is kept in res.locals. */
export function requireSession(store: SessionStore): RequestHandler {
  return async (req, res, next) => {
    const token = sessionToken(req);
    const session = token ? await store.find(token) : undefined;
    if (!session) throw new HttpError(401, 'unauthenticated', 'Not signed in');
    res.locals.session = session;
    next();
  };
}

export function sessionOf(res: Response): Session {
  const session = res.locals.session as Session | undefined;
  if (!session) throw new Error('requireSession must run before this handler');
  return session;
}

const profilePatch = z
  .object({
    handle: z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/, '3–20 characters: letters, digits or _').optional(),
    displayName: z.string().trim().min(1).max(60).optional(),
  })
  .refine((p) => p.handle !== undefined || p.displayName !== undefined, 'nothing to change');

export function meRouter(pool: pg.Pool, store: SessionStore): Router {
  const router = Router();
  router.get('/me', requireSession(store), async (_req, res) => {
    const user = await getUser(pool, sessionOf(res).user.id);
    if (!user) throw new HttpError(401, 'unauthenticated', 'Not signed in');
    res.json({ user });
  });
  router.patch('/me', requireSession(store), async (req, res) => {
    const patch = profilePatch.parse(req.body);
    res.json({
      user: await updateProfile(pool, sessionOf(res).user.id, {
        ...(patch.handle !== undefined && { handle: patch.handle }),
        ...(patch.displayName !== undefined && { displayName: patch.displayName }),
      }),
    });
  });
  return router;
}
