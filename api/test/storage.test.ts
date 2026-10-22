import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorage, StorageError, TooLargeError } from '../src/media/storage.js';

let root: string;
let store: LocalStorage;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chitthi-media-'));
  store = new LocalStorage(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file under the root, as relative paths. */
async function files(dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/** A source that yields `chunks` chunks of `size` bytes, optionally failing after `failAfter`. */
function chunked(chunks: number, size: number, failAfter?: number): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (failAfter !== undefined && i === failAfter) {
        this.destroy(new Error('client went away'));
        return;
      }
      if (i++ === chunks) this.push(null);
      else this.push(Buffer.alloc(size, 0x61));
    },
  });
}

describe('local storage driver', () => {
  it('stores under a random key with size and SHA-256, readable back, nothing left in .tmp', async () => {
    const body = 'letters arrive in order';
    const stored = await store.put(Readable.from([Buffer.from(body)]));
    expect(stored.key).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.size).toBe(body.length);
    expect(stored.sha256.equals(createHash('sha256').update(body).digest())).toBe(true);
    expect(await files()).toEqual([`${stored.key.slice(0, 2)}/${stored.key.slice(2, 4)}/${stored.key}`]);
    const got = await store.get(stored.key);
    expect(got?.size).toBe(body.length);
    expect(await text(got?.stream ?? Readable.from([]))).toBe(body);
    if (process.platform !== 'win32') {
      expect((await stat(join(root, stored.key.slice(0, 2), stored.key.slice(2, 4), stored.key))).mode & 0o777).toBe(0o600);
    }
  });

  it('two puts of the same bytes get different keys (no dedup: deleting one never affects the other)', async () => {
    const [a, b] = await Promise.all([store.put(Readable.from([Buffer.from('same')])), store.put(Readable.from([Buffer.from('same')]))]);
    expect(a.key).not.toBe(b.key);
    await store.delete(a.key);
    expect(await store.get(a.key)).toBeUndefined();
    expect(await store.get(b.key)).toBeDefined();
  });

  it('cuts a stream off mid-way past maxBytes and keeps nothing', async () => {
    const source = chunked(100, 64 * 1024); // 6.4 MB offered
    const put = store.put(source, { maxBytes: 200 * 1024 });
    await expect(put).rejects.toBeInstanceOf(TooLargeError);
    expect(source.destroyed).toBe(true); // stopped reading: the rest was never consumed
    expect(await files()).toEqual([]);
  });

  it("a source that fails mid-stream keeps nothing, and its own error is passed on (it isn't the store's)", async () => {
    await expect(store.put(chunked(10, 1024, 3))).rejects.toThrow('client went away');
    expect(await files()).toEqual([]);
  });

  it('a disk write failure is a StorageError and leaves nothing behind', async () => {
    const blocked = join(root, 'not-a-dir');
    await writeFile(blocked, 'a file where the store expects a directory');
    const broken = new LocalStorage(blocked);
    await expect(broken.put(Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(StorageError);
    expect(await readFile(blocked, 'utf8')).toBe('a file where the store expects a directory');
    expect(await files()).toEqual(['not-a-dir']);
  });

  it('refuses any key it did not generate before touching a path (no traversal)', async () => {
    for (const key of ['../../etc/passwd', '..\\..\\boot.ini', '/etc/passwd', 'C:\\Windows\\win.ini', 'AB'.repeat(16), '0'.repeat(31), `${'0'.repeat(32)}/x`, '']) {
      await expect(store.get(key), key).rejects.toBeInstanceOf(StorageError);
      await expect(store.delete(key), key).rejects.toBeInstanceOf(StorageError);
    }
  });

  it('get of a missing key is undefined; delete is idempotent', async () => {
    expect(await store.get('0'.repeat(32))).toBeUndefined();
    await store.delete('0'.repeat(32));
    const { key } = await store.put(Readable.from([Buffer.from('x')]));
    await store.delete(key);
    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
  });

  it('reports free and total space', async () => {
    const { free, total } = await store.space();
    expect(total).toBeGreaterThan(0);
    expect(free).toBeGreaterThan(0);
    expect(free).toBeLessThanOrEqual(total);
  });
});
