import busboy from 'busboy';
import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { Readable } from 'node:stream';
import { requireSession, sessionOf } from '../auth.js';
import { HttpError } from '../errors.js';
import type { RateLimits } from '../limits.js';
import type { SessionStore } from '../sessions.js';
import { IMAGE_MAX_BYTES, ImageRejected, processImage } from './image.js';
import { displayName, type StoredMime } from './names.js';
import { NotTextError, SNIFF_BYTES, sniff, TextGuard, type Detected } from './sniff.js';
import { StorageError, TooLargeError, type Storage, type StoredObject } from './storage.js';

export const FILE_MAX_BYTES = 25 * 1024 * 1024;

/** What an upload answers with, and what a message carries for each attachment. */
export type AttachmentInfo = {
  id: string;
  kind: 'image' | 'file';
  mime: StoredMime;
  size: number;
  name: string;
  width: number | null;
  height: number | null;
  placeholder: string | null;
};

const unsupported = () => new HttpError(415, 'unsupported_type', 'Chitthi takes photos (JPEG, PNG, WebP, static GIF), PDFs, plain text and ZIP files.');
const tooLarge = (kind: 'image' | 'file') =>
  new HttpError(413, 'too_large', kind === 'image' ? 'Photos can be up to 10 MB.' : 'Files can be up to 25 MB.');

const IMAGE_ERRORS: Record<ImageRejected['reason'], () => HttpError> = {
  animated: () => new HttpError(415, 'unsupported_type', "Animated images aren't supported. Send a still image."),
  too_many_pixels: () => new HttpError(413, 'too_large', 'That image has too many pixels.'),
  too_large: () => new HttpError(413, 'too_large', 'Photos can be up to 10 MB.'),
  unreadable: () => new HttpError(415, 'unsupported_type', "That image couldn't be read."),
  mismatch: () => new HttpError(415, 'unsupported_type', "That image couldn't be read."),
};

/**
 * Global disk guard: below max(15 %, 2 GB) free where media is stored, new uploads are refused
 * with 507 (text messages keep working). The reading is cached for a few seconds; the warning is
 * logged at most once an hour.
 */
export function diskGuard(storage: Pick<Storage, 'space'>, logger: Logger, opts: { minFreeBytes?: number; minFreeRatio?: number; now?: () => number } = {}) {
  const { minFreeBytes = 2 * 1024 ** 3, minFreeRatio = 0.15, now = Date.now } = opts;
  let cached: { at: number; ok: boolean } | undefined;
  let warnedAt = -Infinity;
  return async (): Promise<void> => {
    const t = now();
    if (!cached || t - cached.at > 5_000) {
      const { free, total } = await storage.space();
      const ok = free >= Math.max(minFreeBytes, total * minFreeRatio);
      cached = { at: t, ok };
      if (!ok && t - warnedAt >= 60 * 60 * 1000) {
        warnedAt = t;
        logger.warn({ freeBytes: free, totalBytes: total }, 'media storage nearly full: refusing new uploads');
      }
    }
    if (!cached.ok) throw new HttpError(507, 'storage_full', 'Storage is full right now. Try again later. Text messages still work.');
  };
}

/** Collects a stream into memory up to max bytes (images only: they are decoded in memory anyway). */
async function collect(source: AsyncIterable<Buffer>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > max) throw new TooLargeError(max);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reads until the type can be decided; returns it with a stream of the whole file (head included). */
async function inspect(file: Readable): Promise<{ detected: Detected | undefined; body: AsyncIterable<Buffer> }> {
  const it = file[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let head = Buffer.alloc(0);
  let done = false;
  while (head.length < SNIFF_BYTES) {
    const next = await it.next();
    if (next.done) {
      done = true;
      break;
    }
    head = Buffer.concat([head, next.value]);
  }
  async function* body(): AsyncGenerator<Buffer> {
    if (head.length > 0) yield head;
    if (done) return;
    for (let n = await it.next(); !n.done; n = await it.next()) yield n.value;
  }
  return { detected: sniff(head), body: body() };
}

/** Text is checked as it streams to the store: UTF-8, no binary bytes, not markup. */
async function* guarded(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const guard = new TextGuard();
  for await (const chunk of source) {
    guard.check(chunk);
    yield chunk;
  }
  guard.finish();
}

type Stored = {
  info: Omit<AttachmentInfo, 'id'>;
  key: string;
  thumbKey: string | null;
  sha256: Buffer;
  /** Everything written for it (main file and thumbnail): what the daily byte quota is charged. */
  bytes: number;
};

/**
 * POST /api/uploads: one multipart file part, streamed. The type comes from the bytes; the cap
 * (10 MB images, 25 MB files) is enforced while reading, and going over answers 413 at once and
 * closes the connection. Nothing is kept from a refused upload.
 */
export function uploadsRouter(pool: pg.Pool, sessions: SessionStore, storage: Storage, rateLimits: RateLimits, logger: Logger, guard = diskGuard(storage, logger)): Router {
  const router = Router();

  async function store(detected: Detected, body: AsyncIterable<Buffer>, clientName: string | undefined): Promise<Stored> {
    if (detected.kind === 'image') {
      const img = await processImage(await collect(body, IMAGE_MAX_BYTES), detected.format);
      const main = await storage.put(Readable.from([img.data]));
      let thumb: StoredObject;
      try {
        thumb = await storage.put(Readable.from([img.thumb]));
      } catch (err) {
        await storage.delete(main.key).catch(() => undefined);
        throw err;
      }
      return {
        info: { kind: 'image', mime: img.mime, size: main.size, name: displayName(clientName, img.mime), width: img.width, height: img.height, placeholder: img.placeholder },
        key: main.key, thumbKey: thumb.key, sha256: main.sha256, bytes: main.size + thumb.size,
      };
    }
    const obj = await storage.put(Readable.from(detected.mime === 'text/plain' ? guarded(body) : body), { maxBytes: FILE_MAX_BYTES });
    return {
      info: { kind: 'file', mime: detected.mime, size: obj.size, name: displayName(clientName, detected.mime), width: null, height: null, placeholder: null },
      key: obj.key, thumbKey: null, sha256: obj.sha256, bytes: obj.size,
    };
  }

  router.post('/uploads', requireSession(sessions), async (req: Request, res: Response) => {
    const userId = sessionOf(res).user.id;
    await guard();
    await rateLimits.uploadCount(userId);
    if (!req.is('multipart/form-data')) throw new HttpError(400, 'invalid_request', 'Send the file as multipart/form-data.');

    const stored = await new Promise<Stored>((resolve, reject) => {
      let bb: busboy.Busboy;
      try {
        // defParamCharset: busboy reads the filename parameter as Latin-1 unless told otherwise.
        bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fields: 0, fileSize: FILE_MAX_BYTES + 1, headerPairs: 20 } });
      } catch {
        reject(new HttpError(400, 'invalid_request', 'Malformed multipart body.'));
        return;
      }
      // Settles once: with the stored file only after the whole multipart body ended cleanly
      // (so a second file or a stray field refuses the upload), otherwise with the first error.
      // Whatever was stored for an upload that ends up refused is removed again.
      let started = false;
      let failed: Error | undefined;
      let file: Promise<Stored> | undefined;
      let current: Readable | undefined;
      const discard = (s: Stored) => Promise.all([s.key, s.thumbKey].flatMap((k) => (k ? [storage.delete(k).catch(() => undefined)] : [])));
      const fail = (err: unknown) => {
        if (failed) return;
        const reason = err instanceof Error ? err : new Error(String(err));
        failed = reason;
        req.unpipe(bb);
        // Stop the file being stored (its partial write is cleaned up by the store), remove it
        // if it already finished, and answer only once that has settled.
        current?.destroy(reason);
        void (file ?? Promise.reject(reason)).then(discard, () => undefined).finally(() => { reject(reason); });
      };
      bb.on('file', (_field, stream, info) => {
        if (started) {
          stream.resume();
          return;
        }
        started = true;
        current = stream;
        // busboy's own limit is a backstop one byte past the largest cap; ours fire first.
        stream.on('limit', () => { stream.destroy(new TooLargeError(FILE_MAX_BYTES)); });
        file = (async () => {
          const { detected, body } = await inspect(stream);
          if (!detected) throw unsupported();
          return store(detected, body, info.filename);
        })();
        file.catch((err: unknown) => {
          stream.resume();
          fail(err);
        });
      });
      bb.on('filesLimit', () => { fail(new HttpError(400, 'invalid_request', 'Send one file per upload.')); });
      bb.on('fieldsLimit', () => { fail(new HttpError(400, 'invalid_request', 'Send only the file.')); });
      bb.on('error', () => { fail(new HttpError(400, 'invalid_request', 'Malformed multipart body.')); });
      bb.on('close', () => {
        if (!file) {
          fail(new HttpError(400, 'no_file', 'No file in the upload.'));
          return;
        }
        file.then((s) => {
          if (failed) void discard(s);
          else resolve(s);
        }, () => undefined); // its failure was already reported
      });
      req.on('aborted', () => { fail(new HttpError(400, 'aborted', 'The upload was interrupted.')); });
      req.pipe(bb);
    }).catch((err: unknown) => {
      // A refused upload stops here: answer now, then close rather than read the rest of it. For
      // at most 2 s after answering, whatever the client still sends is read and discarded
      // (never stored) so it can receive the answer: closing a socket with unread data resets
      // it, and a reset can wipe out the response before the client reads it. (No
      // "Connection: close" header: with it Node destroys the socket the moment the response is
      // written, which is exactly that reset.)
      res.once('finish', () => {
        req.resume();
        setTimeout(() => { req.socket.destroy(); }, 2_000).unref();
      });
      if (err instanceof HttpError) throw err;
      if (err instanceof TooLargeError) throw tooLarge(err.maxBytes > IMAGE_MAX_BYTES ? 'file' : 'image');
      if (err instanceof NotTextError) throw unsupported();
      if (err instanceof ImageRejected) throw IMAGE_ERRORS[err.reason]();
      if (err instanceof StorageError) {
        logger.error({ err }, 'media storage write failed');
        throw new HttpError(503, 'storage_unavailable', "Couldn't save the file. Try again in a moment.");
      }
      throw err;
    });

    const { info, sha256, key, thumbKey, bytes } = stored;
    const forget = () => Promise.all([key, thumbKey].flatMap((k) => (k ? [storage.delete(k).catch(() => undefined)] : [])));
    try {
      await rateLimits.uploadBytes(userId, bytes);
      const { rows: [row] } = await pool.query<{ id: string }>(
        `INSERT INTO attachments (uploader_id, kind, mime, byte_size, sha256, file_name, storage_key, thumb_key, width, height, placeholder)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [userId, info.kind, info.mime, info.size, sha256, info.name, key, thumbKey, info.width, info.height, info.placeholder],
      );
      if (!row) throw new Error('insert returned no row');
      const attachment: AttachmentInfo = { id: row.id, ...info };
      res.status(201).json({ attachment });
    } catch (err) {
      await forget(); // over the byte quota, or the row was refused: keep nothing
      throw err;
    }
  });

  return router;
}
