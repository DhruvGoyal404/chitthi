import { Router } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { requireSession, sessionOf } from '../auth.js';
import { HttpError } from '../errors.js';
import type { ImageProcessor } from './image.js';
import type { SessionStore } from '../sessions.js';
import type { Storage } from './storage.js';
import { contentDisposition } from './downloads.js';

/**
 * Avatars are our own copy of the sign-in provider's picture (docs/MEDIA.md, "Avatars"). At every
 * sign-in the server fetches it, re-encodes it (image.ts: AVATAR_EDGE square WebP, metadata
 * dropped) and stores it with the media; browsers only ever load /api/users/<id>/avatar, so no
 * viewer contacts Google or GitHub. Without a copy, the app shows initials.
 */

/** The only hosts a picture is fetched from: the providers' own avatar servers. */
const AVATAR_HOSTS = [/^lh[3-6]\.googleusercontent\.com$/, /^avatars\.githubusercontent\.com$/];
export const AVATAR_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_FETCH_TIMEOUT_MS = 5000;
const AVATAR_STORE_MAX_BYTES = 256 * 1024;

/**
 * The provider's picture address, if it is one we fetch from: https, an allow-listed host, no
 * credentials or port. Asks for a 256 px picture where the provider supports it (Google's
 * `=s96-c` suffix, GitHub's `s` parameter), so the 128 px copy stays sharp.
 */
export function avatarSource(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!AVATAR_HOSTS.some((h) => h.test(url.hostname))) return null;
  if (url.hostname.endsWith('googleusercontent.com')) url.pathname = url.pathname.replace(/=s\d+(-c)?$/, '=s256-c');
  else url.searchParams.set('s', '256');
  return url;
}

export type AvatarFetcher = (url: URL) => Promise<Buffer>;

/** Fetches the picture: no redirects (an allow-listed host can't send us elsewhere), a timeout, and a size cap while streaming. */
export const fetchAvatar: AvatarFetcher = async (url) => {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS), headers: { Accept: 'image/*' } });
  if (!res.ok || !res.body) throw new Error(`avatar fetch: HTTP ${String(res.status)}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > AVATAR_FETCH_MAX_BYTES) throw new Error('avatar fetch: too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > AVATAR_FETCH_MAX_BYTES) throw new Error('avatar fetch: too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

export type Avatars = {
  /**
   * Makes or replaces the user's copy from the provider's picture (`providerUrl`; undefined means
   * the address already stored, as after signup). Never throws: without a picture, or when the
   * fetch or the decode fails, the user keeps the copy they had, or initials. The old file is
   * removed once the new one is in place.
   */
  refresh: (userId: string, providerUrl?: string | null) => Promise<void>;
};

export function avatarService(pool: pg.Pool, storage: Storage, images: ImageProcessor, logger: Logger, fetcher: AvatarFetcher = fetchAvatar): Avatars {
  return {
    async refresh(userId, providerUrl) {
      let raw = providerUrl;
      if (raw === undefined) {
        const { rows: [u] } = await pool.query<{ avatar_url: string | null }>('SELECT avatar_url FROM users WHERE id = $1', [userId]);
        raw = u?.avatar_url ?? null;
      }
      const source = avatarSource(raw);
      if (!source) return;
      let key: string | undefined;
      try {
        const webp = await images.avatar(await fetcher(source));
        key = (await storage.put(Readable.from([webp]), { maxBytes: AVATAR_STORE_MAX_BYTES })).key;
        // `o` is the row before this update: its avatar_key is the file being replaced.
        const { rows: [row] } = await pool.query<{ old: string | null }>(
          `UPDATE users u SET avatar_key = $2, avatar_url = $3 FROM users o
            WHERE u.id = $1 AND o.id = u.id AND u.disabled_at IS NULL RETURNING o.avatar_key AS old`,
          [userId, key, raw],
        );
        if (!row) {
          await storage.delete(key);
          return;
        }
        if (row.old) await storage.delete(row.old);
      } catch (err) {
        if (key) await storage.delete(key).catch(() => undefined);
        logger.warn({ userId, host: source.hostname, err: err instanceof Error ? err.message : String(err) }, 'avatar not refreshed');
      }
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /users/:id/avatar: the user's own copy, to themselves and to anyone who has ever shared a
 * conversation with them. Everyone else, and every user without a copy, gets the same 404, so
 * nothing about an account can be probed. Served like an attachment (downloads.ts): attachment
 * disposition, nosniff, a sandbox CSP, private caching (the URL's ?v= changes with the picture).
 */
export function avatarsRouter(pool: pg.Pool, sessions: SessionStore, storage: Storage, logger: Logger): Router {
  const router = Router();
  router.get('/users/:id/avatar', requireSession(sessions), async (req, res) => {
    const notFound = new HttpError(404, 'not_found', 'Not found');
    const id = String(req.params.id);
    if (!UUID.test(id)) throw notFound;
    const viewer = sessionOf(res).user.id;
    const { rows: [u] } = await pool.query<{ avatar_key: string }>(
      `SELECT u.avatar_key FROM users u
        WHERE u.id = $1 AND u.avatar_key IS NOT NULL AND u.disabled_at IS NULL
          AND (u.id = $2 OR EXISTS (
            SELECT 1 FROM conversation_memberships a JOIN conversation_memberships b ON b.conversation_id = a.conversation_id
             WHERE a.user_id = $2 AND b.user_id = u.id))`,
      [id, viewer],
    );
    if (!u) throw notFound;
    const obj = await storage.get(u.avatar_key);
    if (!obj) {
      logger.warn({ userId: id }, 'avatar file missing from storage');
      throw notFound;
    }
    res.set({
      'Content-Type': 'image/webp',
      'Content-Length': String(obj.size),
      'Content-Disposition': contentDisposition('avatar.webp'),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400',
      Vary: 'Cookie',
      ETag: `"${u.avatar_key}"`, // a new picture is a new key
    });
    if (req.fresh) {
      obj.stream.destroy();
      res.status(304).end();
      return;
    }
    await pipeline(obj.stream, res);
  });
  return router;
}
