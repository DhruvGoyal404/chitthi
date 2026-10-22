import { Router, type RequestHandler, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { HttpError } from './errors.js';
import { deleteAccount } from './repo/account.js';
import { getUser, updateProfile } from './repo/users.js';
import { SESSION_COOKIE, sessionToken, type Session, type SessionStore } from './sessions.js';

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

const deleteBody = z.object({
  /** The account's handle, typed again: deletion can't happen by a stray click. */
  confirmHandle: z.string().trim().min(1),
  /** Also erase the body of every message I sent (they stay as "deleted" for everyone). */
  eraseMessages: z.boolean().default(false),
});

export function meRouter(pool: pg.Pool, store: SessionStore, purge: (scope: { uploaderId: string }) => Promise<unknown> = () => Promise.resolve()): Router {
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
  // Account deletion. Signs this browser out; the database trigger disconnects every socket.
  router.delete('/me', requireSession(store), async (req, res) => {
    const { confirmHandle, eraseMessages } = deleteBody.parse(req.body);
    const session = sessionOf(res);
    if (confirmHandle.toLowerCase() !== session.user.handle.toLowerCase()) {
      throw new HttpError(400, 'confirmation_mismatch', 'Type your handle exactly to confirm.');
    }
    const result = await deleteAccount(pool, session.user.id, { eraseMessages });
    // Media marked deleted by the deletion (unsent uploads, and with eraseMessages all of it).
    await purge({ uploaderId: session.user.id });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ deleted: true, ...result });
  });
  return router;
}
