import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { buffer } from 'node:stream/consumers';
import type { Express } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Limits } from '../src/limits.js';
import { diskGuard } from '../src/media/uploads.js';
import { LocalStorage, StorageError, type Storage } from '../src/media/storage.js';
import { as, GENEROUS, signIn, testApp, type Signed } from './apphelpers.js';
import { appPool } from './dbhelpers.js';
import { over, roomy } from './mediahelpers.js';
import { captureLogger, testConfig, WEB_ORIGIN } from './helpers.js';

const apiUrl = inject('apiDbUrl');
const b = (s: string) => Buffer.from(s, 'utf8');
const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 90, b: 160 } } });

let root: string;
let storage: LocalStorage;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chitthi-uploads-'));
  storage = new LocalStorage(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every stored object, as relative paths (".tmp" leftovers included, which must never stay). */
async function stored(dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await stored(p)));
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

describe.skipIf(!apiUrl)('POST /api/uploads', () => {
  const pool = appPool(apiUrl);
  afterAll(async () => {
    await pool.end();
  });
  const appWith = (limits: Partial<Limits> = {}, store: Storage = roomy(storage)) => testApp(pool, apiUrl, { ...GENEROUS, ...limits }, { storage: store });
  /** A signed-in, same-origin multipart POST (the shared `as` helper always sends JSON). */
  const post = (app: Express, u: Signed) => request(app).post('/api/uploads').set('Cookie', u.cookie).set('Origin', WEB_ORIGIN);
  const upload = (app: Express, u: Signed, data: Buffer, filename: string, contentType = 'application/octet-stream') =>
    post(app, u).attach('file', data, { filename, contentType });
  type Row = { kind: string; mime: string; file_name: string; storage_key: string; thumb_key: string | null };
  const rowsOf = async (u: Signed): Promise<Row[]> =>
    (await pool.query<Row>('SELECT kind, mime, file_name, storage_key, thumb_key FROM attachments WHERE uploader_id = $1', [u.id])).rows;

  it('stores a photo re-encoded (no EXIF), with a thumbnail, and answers what the client needs', async () => {
    const app = appWith();
    const u = await signIn(app, 'up');
    const photo = await solid(3000, 2000).jpeg().withExif({ IFD0: { Artist: 'Secret Artist' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '28/1 36/1 0/1' } }).toBuffer();
    const res = await upload(app, u, photo, 'IMG_0042.JPG', 'image/jpeg');
    expect(res.status).toBe(201);
    expect(res.body.attachment).toMatchObject({ kind: 'image', mime: 'image/jpeg', name: 'IMG_0042.JPG', width: 2560, height: 1707 });
    expect(res.body.attachment.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/); // random v4: not guessable from time
    expect(res.body.attachment.placeholder).toMatch(/^data:image\/webp;base64,/);
    const [row] = await rowsOf(u);
    const main = await storage.get(String(row?.storage_key));
    const bytes = await buffer(main?.stream ?? (await import('node:stream')).Readable.from([]));
    expect((await sharp(bytes).metadata()).exif).toBeUndefined();
    expect(bytes.toString('latin1')).not.toContain('Secret Artist');
    expect(await stored()).toHaveLength(2); // the image and its thumbnail, nothing in .tmp
  });

  it('stores PDFs, text and ZIPs as files; the name on disk is never the client name', async () => {
    const app = appWith();
    const u = await signIn(app, 'fl');
    expect((await upload(app, u, b('%PDF-1.7\n1 0 obj\n'), 'notes.pdf', 'application/pdf')).body.attachment).toMatchObject({ kind: 'file', mime: 'application/pdf', name: 'notes.pdf' });
    expect((await upload(app, u, b('dal, chawal, sabzi'), '../../etc/passwd', 'text/plain')).body.attachment).toMatchObject({ mime: 'text/plain', name: 'passwd.txt' });
    expect((await upload(app, u, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'), 'C:\\x\\..\\a.zip')).body.attachment).toMatchObject({ mime: 'application/zip', name: 'a.zip' });
    const files = await stored();
    expect(files).toHaveLength(3);
    for (const f of files) expect(f).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}$/);
  });

  it('refuses spoofed types: HTML renamed .png, SVG with a script, markup late in a "text" file, an executable', async () => {
    const app = appWith();
    const u = await signIn(app, 'sp');
    const cases: [Buffer, string, string][] = [
      [b('<!doctype html><script>alert(document.cookie)</script>'), 'cat.png', 'image/png'],
      [b('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg', 'image/svg+xml'],
      [b(`${' '.repeat(10_000)}<html><body onload=alert(1)>`), 'readme.txt', 'text/plain'],
      [b('\ufeff\n<?xml version="1.0"?><svg/>'), 'data.txt', 'text/plain'],
      [Buffer.concat([Buffer.from('4d5a9000', 'hex'), randomBytes(2000)]), 'photo.jpg', 'image/jpeg'],
    ];
    for (const [data, name, type] of cases) {
      const res = await upload(app, u, data, name, type);
      expect(res.status, name).toBe(415);
      expect(res.body.error.code).toBe('unsupported_type');
    }
    expect(await rowsOf(u)).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('polyglots are stored without their payload; animated GIFs are refused calmly', async () => {
    const app = appWith();
    const u = await signIn(app, 'pg');
    const pngHtml = Buffer.concat([await solid(50, 50).png().toBuffer(), b('<html><script>alert(1)</script>')]);
    const jpgZip = Buffer.concat([await solid(50, 50).jpeg().toBuffer(), Buffer.from('504b03041400', 'hex'), randomBytes(200)]);
    for (const [data, name] of [[pngHtml, 'a.png'], [jpgZip, 'b.jpg']] as const) {
      expect((await upload(app, u, data, name)).status).toBe(201);
    }
    for (const row of await rowsOf(u)) {
      const got = await storage.get(row.storage_key);
      const bytes = await buffer(got?.stream ?? (await import('node:stream')).Readable.from([]));
      expect(bytes.toString('latin1')).not.toContain('<script');
      expect(bytes.includes(Buffer.from('504b0304', 'hex'))).toBe(false);
    }
    const gif = Buffer.from('474946383961010001008000' + '00ff000000' + '00ff' + '21ff0b4e45545343415045322e300301000000'
      + '21f904000a0000002c0000000001000100000202440100' + '21f904000a0000002c00000000010001000002024c0100' + '3b', 'hex');
    const animated = await upload(app, u, gif, 'dance.gif', 'image/gif');
    expect(animated.status).toBe(415);
    expect(animated.body.error.message).toBe("Animated images aren't supported. Send a still image.");
  });

  it('cuts an oversized chunked upload off mid-stream: 413 long before the client finishes, nothing kept', async () => {
    const app = appWith();
    const u = await signIn(app, 'big');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    // A raw chunked request, so nothing (not even a Content-Length) tells the server the size up front.
    const attempt = (head: Buffer, total: number) => new Promise<{ status: number; sentWhenAnswered: number }>((resolve, reject) => {
      const boundary = 'chitthiBoundary7MA4YWxk';
      const req = httpRequest({
        host: '127.0.0.1', port, path: '/api/uploads', method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked', Origin: WEB_ORIGIN, Cookie: u.cookie },
      });
      let sent = 0;
      let answered = false;
      req.on('response', (res) => {
        answered = true;
        const sentWhenAnswered = sent;
        res.resume();
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, sentWhenAnswered }); });
      });
      req.on('error', (err) => { if (!answered) reject(err); }); // the server may close while we still write
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      req.write(head);
      sent = head.length;
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      const pump = () => {
        while (!answered && sent < total) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once('drain', pump);
            return;
          }
        }
        if (!answered) req.end(`\r\n--${boundary}--\r\n`);
      };
      pump();
    });
    try {
      const pdf = await attempt(b('%PDF-1.7\n'), 60 * 1024 * 1024);
      expect(pdf.status).toBe(413);
      expect(pdf.sentWhenAnswered).toBeLessThan(40 * 1024 * 1024); // stopped near the 25 MB cap, not after 60 MB
      const jpeg = await attempt(Buffer.from('ffd8ffe000104a464946', 'hex'), 40 * 1024 * 1024);
      expect(jpeg.status).toBe(413);
      expect(jpeg.sentWhenAnswered).toBeLessThan(25 * 1024 * 1024); // images stop near 10 MB
    } finally {
      server.close();
    }
    expect(await rowsOf(u)).toEqual([]);
    expect(await stored()).toEqual([]);
  }, 60_000);

  it('quotas: the count is checked before reading; going over the byte quota keeps nothing', async () => {
    const counted = appWith({ uploadCount: { points: 2, duration: 86_400 } });
    const u = await signIn(counted, 'qc');
    expect((await upload(counted, u, b('one'), 'a.txt')).status).toBe(201);
    expect((await upload(counted, u, b('two'), 'b.txt')).status).toBe(201);
    const third = await upload(counted, u, b('three'), 'c.txt');
    expect(third.status).toBe(429);
    expect(third.body.error.details.limit).toBe('uploadCount');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);

    await rm(root, { recursive: true, force: true });
    const bytes = appWith({ uploadBytes: { points: 1000, duration: 86_400 } });
    const v = await signIn(bytes, 'qb');
    expect((await upload(bytes, v, b('x'.repeat(600)), 'a.txt')).status).toBe(201);
    const over = await upload(bytes, v, b('y'.repeat(600)), 'b.txt');
    expect(over.status).toBe(429);
    expect(over.body.error.details.limit).toBe('uploadBytes');
    expect(await rowsOf(v)).toHaveLength(1);
    expect(await stored()).toHaveLength(1); // the refused one was removed again
  });

  it('a disk write failure answers 503 cleanly and keeps nothing', async () => {
    const failing = over(storage, {
      put: () => Promise.reject(new StorageError('ENOSPC: no space left on device')),
      space: () => Promise.resolve({ free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }),
    });
    const app = appWith({}, failing);
    const u = await signIn(app, 'df');
    const res = await upload(app, u, b('%PDF-1.4'), 'a.pdf');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('storage_unavailable');
    expect(await rowsOf(u)).toEqual([]);
  });

  it('the disk guard refuses uploads below max(15 %, 2 GB) free with 507; text messages keep working', async () => {
    const GB = 1024 ** 3;
    const reading = { free: 1 * GB, total: 100 * GB };
    const fake = over(storage, { space: () => Promise.resolve(reading) });
    const app = appWith({}, fake);
    const [u, w] = [await signIn(app, 'dg'), await signIn(app, 'dg')];
    const full = await upload(app, u, b('note'), 'a.txt');
    expect(full.status).toBe(507);
    expect(full.body.error).toMatchObject({ code: 'storage_full', message: 'Storage is full right now. Try again later. Text messages still work.' });
    const dm = (await as(app, u).post('/conversations/direct', { userId: w.id })).body.conversation.id as string;
    expect((await as(app, u).post(`/conversations/${dm}/messages`, { clientMsgId: crypto.randomUUID(), body: 'text still works' })).status).toBe(201);
    expect(await stored()).toEqual([]);
  });

  it('the guard: thresholds, a 5 s cache, and one warning per hour', async () => {
    const GB = 1024 ** 3;
    const reading = { free: 0, total: 0 };
    let now = 0;
    const config = testConfig();
    const { logger, lines } = captureLogger(config);
    const guard = diskGuard({ space: () => Promise.resolve(reading) }, logger, { now: () => now });
    const check = async (free: number, total: number) => {
      Object.assign(reading, { free, total });
      now += 6_000; // past the cache
      return guard().then(() => 'ok', (e: unknown) => (e as { code: string }).code);
    };
    expect(await check(20 * GB, 100 * GB)).toBe('ok'); // 20 %, 20 GB
    expect(await check(14 * GB, 100 * GB)).toBe('storage_full'); // under 15 %
    expect(await check(1.9 * GB, 5 * GB)).toBe('storage_full'); // 38 % but under 2 GB
    expect(await check(2.5 * GB, 10 * GB)).toBe('ok'); // 25 % and over 2 GB
    expect(lines.filter((l) => l.includes('media storage nearly full'))).toHaveLength(1); // two refusals, one warning
    now += 60 * 60 * 1000;
    expect(await check(1 * GB, 100 * GB)).toBe('storage_full');
    expect(lines.filter((l) => l.includes('media storage nearly full'))).toHaveLength(2);
  });

  it('needs a session, the allowed Origin, multipart, and exactly one file', async () => {
    const app = appWith();
    const u = await signIn(app, 'mp');
    expect((await request(app).post('/api/uploads').set('Origin', WEB_ORIGIN).attach('file', b('x'), 'a.txt')).status).toBe(401);
    expect((await request(app).post('/api/uploads').set('Cookie', u.cookie).attach('file', b('x'), 'a.txt')).status).toBe(403);
    expect((await as(app, u).post('/uploads', { not: 'multipart' })).status).toBe(400);
    expect((await post(app, u).field('note', 'no file here')).status).toBe(400);
    const two = await post(app, u).attach('file', b('one'), 'a.txt').attach('file', b('two'), 'b.txt');
    expect(two.status).toBe(400);
    expect(await rowsOf(u)).toEqual([]);
    expect(await stored()).toEqual([]);
  });
});
