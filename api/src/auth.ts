import { Router, type RequestHandler, type Response } from 'express';
import { HttpError } from './errors.js';
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

export function meRouter(store: SessionStore): Router {
  const router = Router();
  router.get('/me', requireSession(store), (_req, res) => {
    res.json({ user: sessionOf(res).user });
  });
  return router;
}
