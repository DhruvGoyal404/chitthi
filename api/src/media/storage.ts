import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** What a put stored: its key (random, 32 hex), how many bytes and their SHA-256. */
export type StoredObject = { key: string; size: number; sha256: Buffer };

/** The stream was longer than the caller allowed; nothing was kept. */
export class TooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`more than ${String(maxBytes)} bytes`);
  }
}

/** The store couldn't do it (disk full, permissions, I/O); nothing half-written was kept. */
export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/**
 * Where media bytes live. Callers only ever hold keys the store generated, so a driver for
 * S3-compatible storage can replace the local one without touching them.
 */
export interface Storage {
  /** Stores the stream under a new random key. Rejects with TooLargeError past maxBytes, or StorageError; keeps nothing then. */
  put(source: Readable, opts?: { maxBytes?: number }): Promise<StoredObject>;
  /** The bytes, or undefined when there is no such object. */
  get(key: string): Promise<{ stream: Readable; size: number } | undefined>;
  /** Removes an object; removing a missing one is fine. */
  delete(key: string): Promise<void>;
  /** Free and total bytes where new objects go (the disk guard reads this). */
  space(): Promise<{ free: number; total: number }>;
  /** Every stored object (for reconciling with the database). */
  list(): AsyncIterable<{ key: string; modifiedAt: Date }>;
  /** Removes partial writes older than the cutoff (left by a crash mid-upload); returns how many. */
  cleanTemp(olderThan: Date): Promise<number>;
}

const KEY = /^[0-9a-f]{32}$/;

/** Keys are generated here and nowhere else; anything else is refused before touching a path. */
export function assertKey(key: string): void {
  if (!KEY.test(key)) throw new StorageError('invalid storage key');
}

export const newKey = (): string => randomBytes(16).toString('hex');

/** Counts and hashes what passes through, and fails the pipeline past maxBytes. */
function meter(maxBytes: number) {
  const hash = createHash('sha256');
  let size = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) {
        done(new TooLargeError(maxBytes));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { transform, result: () => ({ size, sha256: hash.digest() }) };
}

/**
 * The local filesystem driver. Objects live at <root>/<k[0..2]>/<k[2..4]>/<key>, written to
 * <root>/.tmp first, fsynced, then renamed into place: a crash or an aborted upload never leaves
 * a partial object under a real key. Files are created 0600, directories 0700. The root must be
 * outside any web root; nothing here is ever served by path.
 */
export class LocalStorage implements Storage {
  private readonly tmp: string;

  constructor(private readonly root: string) {
    this.tmp = join(root, '.tmp');
  }

  private pathOf(key: string): string {
    assertKey(key);
    return join(this.root, key.slice(0, 2), key.slice(2, 4), key);
  }

  async put(source: Readable, { maxBytes = Number.MAX_SAFE_INTEGER }: { maxBytes?: number } = {}): Promise<StoredObject> {
    const key = newKey();
    const tmpPath = join(this.tmp, `${key}.part`);
    const m = meter(maxBytes);
    try {
      await mkdir(this.tmp, { recursive: true, mode: 0o700 });
      await pipeline(source, m.transform, createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }));
      const handle = await open(tmpPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const finalPath = this.pathOf(key);
      await mkdir(join(this.root, key.slice(0, 2), key.slice(2, 4)), { recursive: true, mode: 0o700 });
      await rename(tmpPath, finalPath);
    } catch (err) {
      source.destroy(); // stop reading whatever is left of the upload
      await rm(tmpPath, { force: true }).catch(() => undefined);
      // Filesystem failures (they carry an errno code) are the store's; anything else came from
      // the source (too large, a refused text file, a client that went away) and is passed on.
      if (err instanceof TooLargeError || typeof (err as NodeJS.ErrnoException).code !== 'string') throw err;
      throw new StorageError('could not store the object', err);
    }
    const { size, sha256 } = m.result();
    return { key, size, sha256 };
  }

  async get(key: string): Promise<{ stream: Readable; size: number } | undefined> {
    const path = this.pathOf(key);
    try {
      const s = await stat(path);
      if (!s.isFile()) return undefined;
      return { stream: createReadStream(path), size: s.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new StorageError('could not read the object', err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.pathOf(key), { force: true });
    } catch (err) {
      throw new StorageError('could not delete the object', err);
    }
  }

  async *list(): AsyncIterable<{ key: string; modifiedAt: Date }> {
    const dirs = async (path: string) => (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name));
    for (const a of await dirs(this.root)) {
      for (const b of await dirs(join(this.root, a.name))) {
        for (const f of await readdir(join(this.root, a.name, b.name), { withFileTypes: true })) {
          if (!f.isFile() || !KEY.test(f.name) || !f.name.startsWith(a.name + b.name)) continue;
          const s = await stat(join(this.root, a.name, b.name, f.name)).catch(() => undefined);
          if (s) yield { key: f.name, modifiedAt: s.mtime };
        }
      }
    }
  }

  async cleanTemp(olderThan: Date): Promise<number> {
    let removed = 0;
    for (const f of await readdir(this.tmp, { withFileTypes: true }).catch(() => [])) {
      const path = join(this.tmp, f.name);
      const s = await stat(path).catch(() => undefined);
      if (f.isFile() && s && s.mtime < olderThan) {
        await rm(path, { force: true });
        removed++;
      }
    }
    return removed;
  }

  async space(): Promise<{ free: number; total: number }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const s = await statfs(this.root);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  }
}
