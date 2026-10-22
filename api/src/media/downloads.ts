import { Router, type Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { pipeline } from 'node:stream/promises';
import { requireSession, sessionOf } from '../auth.js';
import { HttpError } from '../errors.js';
import { visibleTo } from '../repo/access.js';
import type { SessionStore } from '../sessions.js';
import type { Storage } from './storage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new HttpError(404, 'not_found', 'Not found');

/** RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

type Row = { mime: string; file_name: string; storage_key: string; thumb_key: string | null; sha256: Buffer };

/**
 * Downloads. Every request is checked like history: the attachment must belong to a live
 * message inside one of the caller's membership windows. Anything else, including an unknown
 * id, an unattached upload, a deleted message or a message sent after the caller left, is the
 * same 404 (never 403), so ids can't be probed.
 *
 * Nothing is ever served inline as a document: Content-Disposition attachment, nosniff, and a
 * sandboxing CSP with nothing allowed. <img> still displays images (it ignores the
 * disposition). Cache-Control private: browsers may keep a copy, shared caches may not.
 */
export function downloadsRouter(pool: pg.Pool, sessions: SessionStore, storage: Storage, logger: Logger): Router {
  const router = Router();

  async function serve(res: Response, id: string, thumb: boolean): Promise<void> {
    if (!UUID.test(id)) throw notFound();
    const { rows: [a] } = await pool.query<Row>(
      `SELECT a.mime, a.file_name, a.storage_key, a.thumb_key, a.sha256
         FROM attachments a JOIN messages m ON m.id = a.message_id
        WHERE a.id = $1 AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND ${visibleTo('$2')}`,
      [id, sessionOf(res).user.id],
    );
    if (!a) throw notFound();
    const key = thumb ? a.thumb_key : a.storage_key;
    if (!key) throw notFound(); // files have no thumbnail
    const obj = await storage.get(key);
    if (!obj) {
      logger.warn({ attachmentId: id, thumb }, 'attachment file missing from storage');
      throw notFound();
    }
    const mime = thumb ? 'image/webp' : a.mime === 'text/plain' ? 'text/plain; charset=utf-8' : a.mime;
    const name = thumb ? `${a.file_name.replace(/\.[^.]+$/, '')}-thumb.webp` : a.file_name;
    res.set({
      'Content-Type': mime,
      'Content-Length': String(obj.size),
      'Content-Disposition': contentDisposition(name),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400',
      Vary: 'Cookie',
      ETag: `"${a.sha256.toString('hex').slice(0, 32)}${thumb ? '-t' : ''}"`,
    });
    if (res.req.fresh) {
      obj.stream.destroy();
      res.status(304).end();
      return;
    }
    await pipeline(obj.stream, res);
  }

  router.get('/attachments/:id', requireSession(sessions), async (req, res) => {
    await serve(res, String(req.params.id), false);
  });
  router.get('/attachments/:id/thumb', requireSession(sessions), async (req, res) => {
    await serve(res, String(req.params.id), true);
  });
  return router;
}
