import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { avatarService, avatarSource, type AvatarFetcher } from '../src/media/avatars.js';
import { AVATAR_EDGE, imageProcessor } from '../src/media/image.js';
import { reconcileStore } from '../src/media/lifecycle.js';
import { LocalStorage } from '../src/media/storage.js';
import { as, GENEROUS, signIn, testApp } from './apphelpers.js';
import { appPool } from './dbhelpers.js';
import { captureLogger, testConfig } from './helpers.js';

const apiUrl = inject('apiDbUrl');
const GOOGLE_PIC = 'https://lh3.googleusercontent.com/a/someone=s96-c';
const photo = (r: number) => sharp({ create: { width: 640, height: 400, channels: 3, background: { r, g: 60, b: 90 } } })
  .withExif({ IFD0: { Artist: 'Secret Artist' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '28/1 36/1 0/1' } }).jpeg().toBuffer();

describe('avatarSource: only the providers\' avatar hosts, over https', () => {
  it('accepts Google and GitHub pictures, asking for 256 px', () => {
    expect(avatarSource(GOOGLE_PIC)?.href).toBe('https://lh3.googleusercontent.com/a/someone=s256-c');
    expect(avatarSource('https://avatars.githubusercontent.com/u/1?v=4')?.href).toBe('https://avatars.githubusercontent.com/u/1?v=4&s=256');
  });
  it('refuses everything else', () => {
    for (const bad of [null, '', 'not a url', 'http://lh3.googleusercontent.com/a/x', 'https://evil.example/a.png',
      'https://lh3.googleusercontent.com.evil.example/a', 'https://user:pw@avatars.githubusercontent.com/u/1',
      'https://avatars.githubusercontent.com:8443/u/1', 'https://169.254.169.254/latest', 'file:///etc/passwd']) {
      expect(avatarSource(bad), String(bad)).toBeNull();
    }
  });
});

describe('the avatar re-encode', () => {
  const images = imageProcessor();
  it('is a small square WebP with no metadata', async () => {
    const out = await images.avatar(await photo(200));
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: AVATAR_EDGE, height: AVATAR_EDGE });
    expect(meta.exif).toBeUndefined();
    expect(out.toString('latin1')).not.toContain('Secret Artist');
  });
  it('refuses what is not a picture', async () => {
    await expect(images.avatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).rejects.toThrow();
    await expect(images.avatar(Buffer.from('<html><script>alert(1)</script></html>'))).rejects.toThrow();
  });
});

describe.skipIf(!apiUrl)('avatars: fetched at sign-in, stored with the media, served to people who share a conversation', () => {
  const pool = appPool(apiUrl);
  const { logger, lines } = captureLogger(testConfig({ DATABASE_URL: apiUrl }));
  let root: string;
  let storage: LocalStorage;
  let calls: string[];
  let next: () => Promise<Buffer>;
  const fetcher: AvatarFetcher = async (url) => {
    calls.push(url.href);
    return next();
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chitthi-avatars-'));
    storage = new LocalStorage(root);
    calls = [];
    next = () => photo(200);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await pool.end();
  });
  const keyOf = async (id: string) =>
    (await pool.query<{ avatar_key: string | null }>('SELECT avatar_key FROM users WHERE id = $1', [id])).rows[0]?.avatar_key ?? null;

  it('serves the copy to the user and their conversation partners only, as an attachment, cached by key', async () => {
    const app = testApp(pool, apiUrl, GENEROUS, { storage, fetchAvatar: fetcher });
    const avatars = avatarService(pool, storage, imageProcessor(), logger, fetcher);
    const [a, b, c] = [await signIn(app, 'av'), await signIn(app, 'av'), await signIn(app, 'av')];
    expect((await as(app, a).post('/conversations/direct', { userId: b.id })).status).toBe(201);
    await avatars.refresh(a.id, GOOGLE_PIC);
    expect(calls).toEqual(['https://lh3.googleusercontent.com/a/someone=s256-c']);
    const key = await keyOf(a.id);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const url = `/users/${a.id}/avatar`;

    // The DM partner: the inbox, the members list and the picture itself.
    const inbox = (await as(app, b).get('/conversations')).body.conversations[0];
    expect(inbox.peer.avatarUrl).toBe(`/api${url}?v=${key?.slice(0, 12) ?? ''}`);
    const pic = await as(app, b).get(url);
    expect(pic.status).toBe(200);
    expect(pic.headers).toMatchObject({
      'content-type': 'image/webp', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=86400', etag: `"${key ?? ''}"`,
    });
    expect(pic.headers['content-disposition']).toMatch(/^attachment;/);
    expect((await sharp(pic.body as Buffer).metadata()).width).toBe(AVATAR_EDGE);
    expect((await as(app, b).get(url).set('If-None-Match', `"${key ?? ''}"`)).status).toBe(304);
    expect((await as(app, a).get(url)).status).toBe(200); // their own

    // A stranger: the same 404 as for no picture at all, and search shows initials.
    expect((await as(app, c).get(url)).status).toBe(404);
    expect((await as(app, c).get(`/users/${b.id}/avatar`)).status).toBe(404);
    expect((await as(app, c).get(`/users?q=${a.handle}`)).body.users[0]).toMatchObject({ id: a.id, avatarUrl: null });
    expect((await as(app, b).get(`/users?q=${a.handle}`)).body.users[0].avatarUrl).toBe(inbox.peer.avatarUrl);
    expect((await request(app).get(`/api${url}`)).status).toBe(401);
    expect((await as(app, b).get('/users/not-a-uuid/avatar')).status).toBe(404);
  });

  it('replaces the copy (old file removed), keeps it when a refresh fails, and never fetches a foreign host', async () => {
    const app = testApp(pool, apiUrl, GENEROUS, { storage });
    const avatars = avatarService(pool, storage, imageProcessor(), logger, fetcher);
    const a = await signIn(app, 'av');
    await avatars.refresh(a.id, GOOGLE_PIC);
    const first = await keyOf(a.id);
    next = () => photo(20);
    await avatars.refresh(a.id, GOOGLE_PIC);
    const second = await keyOf(a.id);
    expect(second).not.toBe(first);
    expect(await storage.get(first ?? '')).toBeUndefined();

    next = () => Promise.reject(new Error('HTTP 503'));
    await avatars.refresh(a.id, GOOGLE_PIC); // never throws
    next = () => Promise.resolve(Buffer.from('<svg/>'));
    await avatars.refresh(a.id, GOOGLE_PIC);
    expect(await keyOf(a.id)).toBe(second);
    expect(lines.join('')).toContain('avatar not refreshed');

    calls = [];
    await avatars.refresh(a.id, 'https://evil.example/a.png');
    expect(calls).toEqual([]);
    expect(await keyOf(a.id)).toBe(second);

    // The media sweeper keeps a file a user's avatar_key refers to, however old.
    const later = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await reconcileStore(pool, storage, later);
    expect(await storage.get(second ?? '')).toBeDefined();
  });

  it('goes with the account: key cleared, file removed, the partner sees initials', async () => {
    const app = testApp(pool, apiUrl, GENEROUS, { storage });
    const avatars = avatarService(pool, storage, imageProcessor(), logger, fetcher);
    const [a, b] = [await signIn(app, 'av'), await signIn(app, 'av')];
    await as(app, a).post('/conversations/direct', { userId: b.id });
    await avatars.refresh(a.id, GOOGLE_PIC);
    const key = await keyOf(a.id);
    const stored = await storage.get(key ?? '');
    expect(stored).toBeDefined();
    stored?.stream.destroy(); // an open handle would keep the file on Windows

    const del = await as(app, a).delete('/me').send({ confirmHandle: a.handle });
    expect(del.status).toBe(200);
    expect(del.body).not.toHaveProperty('avatarKey');
    expect(await keyOf(a.id)).toBeNull();
    await expect.poll(async () => storage.get(key ?? '')).toBeUndefined();
    expect((await as(app, b).get('/conversations')).body.conversations[0].peer.avatarUrl).toBeNull();
    expect((await as(app, b).get(`/users/${a.id}/avatar`)).status).toBe(404);
  });
});
