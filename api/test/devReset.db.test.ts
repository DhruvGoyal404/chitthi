import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { checkResetTarget, resetDevMedia } from '../src/media/devReset.js';
import { LocalStorage } from '../src/media/storage.js';
import { diskGuard } from '../src/media/uploads.js';
import { as, GENEROUS, signIn, testApp } from './apphelpers.js';
import { adminPool, appPool } from './dbhelpers.js';
import { captureLogger, testConfig, WEB_ORIGIN } from './helpers.js';
import { roomy } from './mediahelpers.js';

const apiUrl = inject('apiDbUrl');
const ownerUrl = inject('dbUrl');
const GB = 1024 ** 3;

describe('the dev-only disk-guard override reaches the guard', () => {
  it('10 % / 3 GB free: refused by the production rule, accepted with the dev override', async () => {
    const { logger } = captureLogger(testConfig());
    const reading = { space: () => Promise.resolve({ free: 3 * GB, total: 30 * GB }) };
    const db = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5435/chitthi' };
    const strict = diskGuard(reading, logger, loadConfig({ NODE_ENV: 'development', ...db }).diskGuard);
    const loose = diskGuard(reading, logger, loadConfig({ NODE_ENV: 'development', ...db, MEDIA_MIN_FREE_PERCENT: '5', MEDIA_MIN_FREE_BYTES: String(GB) }).diskGuard);
    await expect(strict()).rejects.toMatchObject({ status: 507 });
    await expect(loose()).resolves.toBeUndefined();
  });
});

describe('npm run dev:reset-media: target checks', () => {
  const repoRoot = process.platform === 'win32' ? 'E:\\repo' : '/home/me/repo';
  const ok = { nodeEnv: 'development', databaseUrl: 'postgres://chitthi:x@127.0.0.1:5435/chitthi', mediaDir: join(repoRoot, '.data', 'media'), repoRoot };
  it('runs only on a local, non-production setup, against a folder inside <repo>/.data', () => {
    expect(() => { checkResetTarget(ok); }).not.toThrow();
    expect(() => { checkResetTarget({ ...ok, databaseUrl: 'postgres://chitthi:x@localhost:5435/chitthi' }); }).not.toThrow();
    expect(() => { checkResetTarget({ ...ok, nodeEnv: 'production' }); }).toThrow(/production/);
    expect(() => { checkResetTarget({ ...ok, databaseUrl: undefined }); }).toThrow(/MIGRATION_DATABASE_URL/);
    expect(() => { checkResetTarget({ ...ok, databaseUrl: 'postgres://chitthi:x@db.example.com:5432/chitthi' }); }).toThrow(/not on this machine/);
    for (const mediaDir of [join(repoRoot, '.data'), repoRoot, join(repoRoot, '..', 'elsewhere'), join(repoRoot, '.data', '..', 'src')]) {
      expect(() => { checkResetTarget({ ...ok, mediaDir }); }, mediaDir).toThrow(/MEDIA_DIR/);
    }
  });
});

describe.skipIf(!apiUrl)('npm run dev:reset-media: what it does', () => {
  const pool = appPool(apiUrl);
  const admin = adminPool(ownerUrl);
  afterAll(async () => {
    await Promise.all([pool.end(), admin.end()]);
  });

  it('deletes every attachment and file, tombstones media messages, clears upload quotas, and keeps the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chitthi-reset-'));
    const app = testApp(pool, apiUrl, GENEROUS, { storage: roomy(new LocalStorage(root)) });
    const [a, b] = [await signIn(app, 'rs'), await signIn(app, 'rs')];
    const conv = (await as(app, a).post('/conversations/direct', { userId: b.id })).body.conversation.id as string;
    const up = (name: string) => request(app).post('/api/uploads').set('Cookie', a.cookie).set('Origin', WEB_ORIGIN).attach('file', Buffer.from(`%PDF-1.4 ${name}`), name);
    const sent = (await up('sent.pdf')).body.attachment.id as string;
    await up('unsent.pdf');
    const media = (await as(app, a).post(`/conversations/${conv}/messages`, { clientMsgId: randomUUID(), body: 'with a file', attachmentIds: [sent] })).body.message as { id: string };
    const text = (await as(app, a).post(`/conversations/${conv}/messages`, { clientMsgId: randomUUID(), body: 'just text' })).body.message as { id: string };
    await admin.query("INSERT INTO rate_limits (key, points, expire) VALUES ($1, 3, NULL), ($2, 9, NULL)", [`uploadCount:${a.id}`, `send:${a.id}`]);
    expect((await readdir(root, { recursive: true })).length).toBeGreaterThan(0);

    const c = await admin.connect();
    try {
      const report = await resetDevMedia(c, root);
      expect(report.attachmentsDeleted).toBeGreaterThanOrEqual(2);
      expect(report.messagesTombstoned).toBeGreaterThanOrEqual(1);
      expect(report.quotaCountersCleared).toBeGreaterThanOrEqual(1);
    } finally {
      c.release();
    }

    expect((await admin.query('SELECT count(*)::int AS n FROM attachments')).rows[0]).toEqual({ n: 0 });
    const { rows } = await admin.query<{ id: string; deleted: boolean; body: string | null }>(
      'SELECT id, deleted_at IS NOT NULL AS deleted, body FROM messages WHERE id = ANY($1::uuid[])', [[media.id, text.id]],
    );
    expect(rows.find((r) => r.id === media.id)).toMatchObject({ deleted: true, body: null });
    expect(rows.find((r) => r.id === text.id)).toMatchObject({ deleted: false, body: 'just text' });
    const keys = (await admin.query<{ key: string }>('SELECT key FROM rate_limits WHERE key = ANY($1::text[])', [[`uploadCount:${a.id}`, `send:${a.id}`]])).rows.map((r) => r.key);
    expect(keys).toEqual([`send:${a.id}`]); // only upload quotas are cleared
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
    // The no-delete rule is back on afterwards.
    const fresh = (await up('after.pdf')).status;
    expect(fresh).toBe(201);
    await expect(admin.query('DELETE FROM attachments')).rejects.toThrow(/never hard-deleted/);
  });
});
