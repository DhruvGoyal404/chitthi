import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseCookie } from 'cookie';
import type { Request, Response } from 'express';

export const SESSION_COOKIE = 'chitthi_session';
export const SESSION_TTL_DAYS = 7;

/** 256-bit opaque token handed to the client. Only its SHA-256 is stored (no salt needed at this entropy). */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type SessionUser = { id: string; handle: string };
export type Session = { sessionId: string; user: SessionUser; expiresAt: Date };

/**
 * Where sessions live. Phase 1 has only the in-memory store below; the Postgres store (the
 * `sessions` table in docs/SCHEMA.md) replaces it once the domain schema is approved. Both keep
 * only the token hash, never the token.
 */
export interface SessionStore {
  create(user: SessionUser, userAgent: string | undefined): Promise<{ token: string; expiresAt: Date }>;
  find(token: string): Promise<Session | undefined>;
  revoke(token: string): Promise<void>;
}

type Row = { sessionId: string; user: SessionUser; expiresAt: Date; revokedAt?: Date; userAgent?: string };

export class MemorySessionStore implements SessionStore {
  /** Keyed by token hash. Exposed read-only so tests can check that no raw token is held. */
  readonly rows = new Map<string, Row>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(user: SessionUser, userAgent: string | undefined): Promise<{ token: string; expiresAt: Date }> {
    const token = newSessionToken();
    const expiresAt = new Date(this.now().getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const row: Row = { sessionId: randomUUID(), user, expiresAt };
    if (userAgent !== undefined) row.userAgent = userAgent.slice(0, 200);
    this.rows.set(hashSessionToken(token), row);
    return Promise.resolve({ token, expiresAt });
  }

  find(token: string): Promise<Session | undefined> {
    const row = this.rows.get(hashSessionToken(token));
    if (!row || row.revokedAt || row.expiresAt <= this.now()) return Promise.resolve(undefined);
    return Promise.resolve({ sessionId: row.sessionId, user: row.user, expiresAt: row.expiresAt });
  }

  revoke(token: string): Promise<void> {
    const row = this.rows.get(hashSessionToken(token));
    if (row && !row.revokedAt) row.revokedAt = this.now();
    return Promise.resolve();
  }
}

export const sessionToken = (req: Request): string | undefined => parseCookie(req.get('cookie') ?? '')[SESSION_COOKIE];

/**
 * Issues a session and sets its cookie. Rotation: any session the browser came with is revoked
 * first, so a token planted before sign-in (session fixation) never survives a sign-in.
 */
export async function startSession(store: SessionStore, req: Request, res: Response, user: SessionUser, secure: boolean): Promise<void> {
  const previous = sessionToken(req);
  if (previous) await store.revoke(previous);
  const { token, expiresAt } = await store.create(user, req.get('user-agent'));
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: expiresAt });
}
