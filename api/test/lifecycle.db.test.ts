import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Express } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { purgeDeleted, reconcileStore, startSweeper, sweepOnce } from '../src/media/lifecycle.js';
import { LocalStorage, StorageError, type Storage } from '../src/media/storage.js';
import { as, GENEROUS, signIn, testApp, type Signed } from './apphelpers.js';
import { adminPool, appPool } from './dbhelpers.js';
import { captureLogger, testConfig, WEB_ORIGIN } from './helpers.js';
import { over, roomy } from './mediahelpers.js';

const apiUrl = inject('apiDbUrl');
const ownerUrl = inject('dbUrl');
const b = (s: string) => Buffer.from(s, 'utf8');
const { logger } = captureLogger(testConfig());

describe.skipIf(!apiUrl)('media lifecycle', () => {
  const pool = appPool(apiUrl);
  const admin = adminPool(ownerUrl);
  let root: string;
  let storage: LocalStorage;
  let app: Express;
  let photo: Buffer;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chitthi-life-'));
    storage = new LocalStorage(root);
    app = testApp(pool, apiUrl, GENEROUS, { storage: roomy(storage) });
    photo = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 60, b: 60 } } }).png().toBuffer();
  });
  afterAll(async () => {
    await Promise.all([pool.end(), admin.end()]);
  });

  const upload = async (u: Signed, data: Buffer, name: string) => {
    const res = await request(app).post('/api/uploads').set('Cookie', u.cookie).set('Origin', WEB_ORIGIN).attach('file', data, name);
    expect(res.status).toBe(201);
    return res.body.attachment as { id: string };
  };
  const keysOf = async (id: string) => {
    const { rows: [r] } = await pool.query<{ storage_key: string; thumb_key: string | null; deleted: boolean; removed: boolean }>(
      'SELECT storage_key, thumb_key, deleted_at IS NOT NULL AS deleted, blob_removed_at IS NOT NULL AS removed FROM attachments WHERE id = $1', [id],
    );
    if (!r) throw new Error('no row');
    return r;
  };
  /** Test-only: age uploads (created_at is immutable; triggers are off for this one transaction). */
  async function backdate(ids: string[], age: string) {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('UPDATE attachments SET created_at = now() - $2::interval WHERE id = ANY($1::uuid[])', [ids, age]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
  const onDisk = async (key: string | null) => (key ? (await storage.get(key)) !== undefined : false);
  async function dm() {
    const [a, c] = [await signIn(app, 'lc'), await signIn(app, 'lc')];
    const conv = (await as(app, a).post('/conversations/direct', { userId: c.id })).body.conversation.id as string;
    return { a, c, conv };
  }
  const send = (u: Signed, conv: string, ids: string[]) =>
    as(app, u).post(`/conversations/${conv}/messages`, { clientMsgId: randomUUID(), attachmentIds: ids });

  it('a tombstone removes its files right away', async () => {
    const { a, conv } = await dm();
    const img = await upload(a, photo, 'p.png');
    const doc = await upload(a, b('%PDF-1.4'), 'd.pdf');
    const msg = (await send(a, conv, [img.id, doc.id])).body.message as { id: string };
    const [ki, kd] = [await keysOf(img.id), await keysOf(doc.id)];
    expect([await onDisk(ki.storage_key), await onDisk(ki.thumb_key), await onDisk(kd.storage_key)]).toEqual([true, true, true]);

    expect((await as(app, a).delete(`/conversations/${conv}/messages/${msg.id}`)).status).toBe(200);
    expect([await onDisk(ki.storage_key), await onDisk(ki.thumb_key), await onDisk(kd.storage_key)]).toEqual([false, false, false]);
    expect(await keysOf(img.id)).toMatchObject({ deleted: true, removed: true });
  });

  it('account deletion: unsent uploads always go; sent media stays for the others unless "erase" is ticked', async () => {
    for (const erase of [false, true]) {
      const { a, c, conv } = await dm();
      const sent = await upload(a, photo, 'sent.png');
      const unsent = await upload(a, b('draft'), 'draft.txt');
      await send(a, conv, [sent.id]);
      const [ks, ku] = [await keysOf(sent.id), await keysOf(unsent.id)];
      expect((await as(app, a).delete('/me').send({ confirmHandle: a.handle, eraseMessages: erase })).status).toBe(200);
      expect(await onDisk(ku.storage_key), 'unsent upload').toBe(false);
      expect(await onDisk(ks.storage_key), `sent media, erase=${String(erase)}`).toBe(!erase);
      const fetched = await request(app).get(`/api/attachments/${sent.id}`).set('Cookie', c.cookie);
      expect(fetched.status).toBe(erase ? 404 : 200);
    }
  });

  it('the sweeper removes uploads not attached within the hour, and nothing else', async () => {
    const { a, conv } = await dm();
    const old = await upload(a, photo, 'old.png');
    const recent = await upload(a, b('recent'), 'r.txt');
    const oldButSent = await upload(a, b('kept'), 'k.txt');
    await send(a, conv, [oldButSent.id]);
    await backdate([old.id, oldButSent.id], '2 hours');
    await backdate([recent.id], '30 minutes');

    const report = await sweepOnce(pool, storage, logger);
    expect(report.orphans).toBeGreaterThanOrEqual(1);
    const ko = await keysOf(old.id);
    expect(ko).toMatchObject({ deleted: true, removed: true });
    expect([await onDisk(ko.storage_key), await onDisk(ko.thumb_key)]).toEqual([false, false]);
    expect(await keysOf(recent.id)).toMatchObject({ deleted: false });
    expect(await onDisk((await keysOf(recent.id)).storage_key)).toBe(true);
    expect(await keysOf(oldButSent.id)).toMatchObject({ deleted: false });
    expect(await onDisk((await keysOf(oldButSent.id)).storage_key)).toBe(true);
    // A send can no longer use the swept upload.
    expect((await send(a, conv, [old.id])).body.error.code).toBe('attachment_unavailable');
  });

  it('a removal that fails is left pending and retried by the next sweep', async () => {
    const { a, conv } = await dm();
    const doc = await upload(a, b('%PDF-1.4'), 'x.pdf');
    const msg = (await send(a, conv, [doc.id])).body.message as { id: string };
    let failNext = true;
    const flaky: Storage = over(storage, {
      delete: (k) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new StorageError('EIO: i/o error'));
        }
        return storage.delete(k);
      },
    });
    const flakyApp = testApp(pool, apiUrl, GENEROUS, { storage: roomy(flaky) });
    expect((await as(flakyApp, a).delete(`/conversations/${conv}/messages/${msg.id}`)).status).toBe(200); // never fails the delete
    const k = await keysOf(doc.id);
    expect(k).toMatchObject({ deleted: true, removed: false });
    expect(await onDisk(k.storage_key)).toBe(true);

    await purgeDeleted(pool, flaky, logger, { messageId: msg.id });
    expect(await keysOf(doc.id)).toMatchObject({ removed: true });
    expect(await onDisk(k.storage_key)).toBe(false);
  });

  it('reconciling removes stored objects no row knows about (and stale partial writes), but only once they are old', async () => {
    const { a } = await dm();
    const known = await upload(a, b('known'), 'known.txt');
    const kKnown = (await keysOf(known.id)).storage_key;
    const strayOld = (await storage.put(Readable.from([b('crash leftover')]))).key;
    const strayNew = (await storage.put(Readable.from([b('upload in progress')]))).key;
    const pathOf = (k: string) => join(root, k.slice(0, 2), k.slice(2, 4), k);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(pathOf(strayOld), twoHoursAgo, twoHoursAgo);
    await utimes(pathOf(kKnown), twoHoursAgo, twoHoursAgo);
    await mkdir(join(root, '.tmp'), { recursive: true });
    await writeFile(join(root, '.tmp', 'deadbeef.part'), 'half an upload');
    await utimes(join(root, '.tmp', 'deadbeef.part'), twoHoursAgo, twoHoursAgo);
    await writeFile(join(root, '.tmp', 'cafebabe.part'), 'being written now');

    expect(await reconcileStore(pool, storage)).toBe(2); // the old stray and the old .part
    expect(await onDisk(strayOld)).toBe(false);
    expect(await onDisk(strayNew)).toBe(true);
    expect(await onDisk(kKnown)).toBe(true);
    await expect(rm(join(root, '.tmp', 'cafebabe.part'))).resolves.toBeUndefined(); // still there
  });

  it('the sweeper can be turned off (0), and runs on its interval otherwise', async () => {
    await startSweeper(pool, storage, logger, 0).stop();
    let runs = 0;
    const counting = over(storage, { list: () => { runs++; return storage.list(); } });
    const sweeper = startSweeper(pool, counting, logger, 50);
    await new Promise((r) => setTimeout(r, 400));
    await sweeper.stop();
    expect(runs).toBeGreaterThan(0);
  });
});
