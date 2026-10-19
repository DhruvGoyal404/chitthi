import { createHash, randomBytes } from 'node:crypto';
import { parseCookie } from 'cookie';
import type { Request, Response } from 'express';
import type pg from 'pg';

export const SESSION_COOKIE = 'chitthi_session';
export const SESSION_TTL_DAYS = 7;

/** 256-bit opaque token handed to the client. Only its SHA-256 is stored (no salt needed at this entropy). */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export type SessionUser = { id: string; handle: string };
export type Session = { sessionId: string; user: SessionUser; expiresAt: Date };

/** Sessions in Postgres (`sessions` table). Holds only token hashes; the token exists only in the cookie. */
export class SessionStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(userId: string, userAgent: string | undefined): Promise<{ token: string; expiresAt: Date }> {
    const token = newSessionToken();
    const { rows: [row] } = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
       VALUES ($1, $2, now() + make_interval(days => $3), $4) RETURNING expires_at`,
      [userId, hashSessionToken(token), SESSION_TTL_DAYS, userAgent?.slice(0, 200) ?? null],
    );
    if (!row) throw new Error('insert returned no row');
    return { token, expiresAt: row.expires_at };
  }

  /** The live session for a token: not revoked, not expired, user not disabled. */
  async find(token: string): Promise<Session | undefined> {
    const { rows: [row] } = await this.pool.query<{ session_id: string; expires_at: Date; user_id: string; handle: string }>(
      `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.handle
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [hashSessionToken(token)],
    );
    return row && { sessionId: row.session_id, expiresAt: row.expires_at, user: { id: row.user_id, handle: row.handle } };
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashSessionToken(token)]);
  }

  /** "Sign out everywhere". Returns how many live sessions were revoked. */
  async revokeAll(userId: string): Promise<number> {
    const { rowCount } = await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    return rowCount ?? 0;
  }
}

export const sessionToken = (req: Request): string | undefined => parseCookie(req.get('cookie') ?? '')[SESSION_COOKIE];

/**
 * Issues a session and sets its cookie. Rotation: any session the browser came with is revoked
 * first, so a token planted before sign-in (session fixation) never survives a sign-in.
 */
export async function startSession(store: SessionStore, req: Request, res: Response, userId: string, secure: boolean): Promise<void> {
  const previous = sessionToken(req);
  if (previous) await store.revoke(previous);
  const { token, expiresAt } = await store.create(userId, req.get('user-agent'));
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: expiresAt });
}
