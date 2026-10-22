import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { LocalStorage } from '../src/media/storage.js';
import { contentDisposition } from '../src/media/downloads.js';
import type { MessageEvent } from '../src/realtime/fanout.js';
import { as, GENEROUS, signIn, testApp, type Signed } from './apphelpers.js';
import { appPool } from './dbhelpers.js';
import { WEB_ORIGIN } from './helpers.js';
import { connect, next } from './sockets.js';

const apiUrl = inject('apiDbUrl');
const b = (s: string) => Buffer.from(s, 'utf8');

type Info = { id: string; kind: string; mime: string; size: number; name: string; width: number | null; height: number | null; placeholder: string | null };

describe.skipIf(!apiUrl)('messages with attachments, and downloads', () => {
  const pool = appPool(apiUrl);
  let root: string;
  let app: Express;
  let photo: Buffer;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'chitthi-att-'));
    app = testApp(pool, apiUrl, GENEROUS, { storage: new LocalStorage(root) });
    photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 120, b: 90 } } }).jpeg().toBuffer();
  });
  afterAll(async () => {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  });

  const upload = async (u: Signed, data: Buffer, name: string): Promise<Info> => {
    const res = await request(app).post('/api/uploads').set('Cookie', u.cookie).set('Origin', WEB_ORIGIN).attach('file', data, name);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.attachment as Info;
  };
  const send = (u: Signed, conv: string, body: object) => as(app, u).post(`/conversations/${conv}/messages`, { clientMsgId: randomUUID(), ...body });
  const get = (u: Signed | null, path: string) => {
    const r = request(app).get(`/api${path}`);
    return u ? r.set('Cookie', u.cookie) : r;
  };

  async function dm() {
    const [a, c] = [await signIn(app, 'at'), await signIn(app, 'at')];
    const conv = (await as(app, a).post('/conversations/direct', { userId: c.id })).body.conversation.id as string;
    return { a, c, conv };
  }

  it('a message carries up to 10 attachments in order, caption optional; history shows display metadata only', async () => {
    const { a, c, conv } = await dm();
    const img = await upload(a, photo, 'beach.jpg');
    const doc = await upload(a, b('%PDF-1.7\n'), 'ticket.pdf');
    const sent = await send(a, conv, { attachmentIds: [img.id, doc.id] });
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ body: null, attachments: [img, doc] });
    const captioned = await send(a, conv, { body: 'the menu', attachmentIds: [(await upload(a, b('dal makhani'), 'menu.txt')).id] });
    expect(captioned.body.message.body).toBe('the menu');

    const history = (await as(app, c).get(`/conversations/${conv}/messages`)).body.messages as { attachments: Info[] }[];
    expect(history.map((m) => m.attachments.map((x) => x.name))).toEqual([['beach.jpg', 'ticket.pdf'], ['menu.txt']]);
    expect(JSON.stringify(history)).not.toMatch(/storage_key|thumb_key|[0-9a-f]{32}"/);
    expect((await send(a, conv, {})).status).toBe(400); // no body, no attachments
  });

  it('idempotent: a retry with the same attachments returns the original; different ones are a conflict', async () => {
    const { a, conv } = await dm();
    const [x, y] = [await upload(a, b('one'), 'a.txt'), await upload(a, b('two'), 'b.txt')];
    const clientMsgId = randomUUID();
    const first = await as(app, a).post(`/conversations/${conv}/messages`, { clientMsgId, attachmentIds: [x.id] });
    const retry = await as(app, a).post(`/conversations/${conv}/messages`, { clientMsgId, attachmentIds: [x.id] });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ duplicate: true, message: { id: first.body.message.id, attachments: [x] } });
    expect((await as(app, a).post(`/conversations/${conv}/messages`, { clientMsgId, attachmentIds: [y.id] })).status).toBe(409);
    expect((await as(app, a).post(`/conversations/${conv}/messages`, { clientMsgId, body: 'text instead' })).status).toBe(409);
  });

  it("refuses someone else's upload, an already used one, duplicates and more than 10, with one neutral answer", async () => {
    const { a, c, conv } = await dm();
    const theirs = await upload(c, b('theirs'), 'c.txt');
    const used = await upload(a, b('used'), 'u.txt');
    expect((await send(a, conv, { attachmentIds: [used.id] })).status).toBe(201);
    for (const ids of [[theirs.id], [used.id], [randomUUID()]]) {
      const res = await send(a, conv, { attachmentIds: ids });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'attachment_unavailable', message: "An attachment isn't available any more. Attach it again." });
    }
    const fresh = await upload(a, b('fresh'), 'f.txt');
    expect((await send(a, conv, { attachmentIds: [fresh.id, fresh.id] })).status).toBe(400);
    expect((await send(a, conv, { attachmentIds: Array.from({ length: 11 }, () => randomUUID()) })).status).toBe(400);
    expect((await send(a, conv, { attachmentIds: ['../../x'] })).status).toBe(400);
    // The refused sends rolled back: the fresh upload is still free to use.
    expect((await send(a, conv, { attachmentIds: [fresh.id] })).status).toBe(201);
  });

  it('downloads: members only, attachment disposition, nosniff, sandbox CSP, private cache; images also have a thumbnail', async () => {
    const { a, c, conv } = await dm();
    const img = await upload(a, photo, 'Sunset — घर.jpg');
    const txt = await upload(a, b('<b>not html here</b> after text'.replace(/^/, 'x ')), 'page.html');
    await send(a, conv, { attachmentIds: [img.id, txt.id] });

    const main = await get(c, `/attachments/${img.id}`).buffer(true);
    expect(main.status).toBe(200);
    expect(main.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'content-disposition': contentDisposition('Sunset — घर.jpg'),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=86400',
      vary: 'Cookie',
    });
    expect(main.headers['content-disposition']).toMatch(/^attachment; filename="Sunset _ __.jpg"; filename\*=UTF-8''Sunset%20%E2%80%94%20/);
    expect((await sharp(main.body as Buffer).metadata()).width).toBe(640);
    const thumb = await get(c, `/attachments/${img.id}/thumb`).buffer(true);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect((await sharp(thumb.body as Buffer).metadata()).width).toBe(480);

    const text = await get(c, `/attachments/${txt.id}`);
    expect(text.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(text.headers['content-disposition']).toMatch(/filename="page\.html\.txt"/);
    expect((await get(c, `/attachments/${txt.id}/thumb`)).status).toBe(404); // files have none

    const again = await get(c, `/attachments/${img.id}`).set('If-None-Match', String(main.headers.etag));
    expect(again.status).toBe(304);
  });

  it('everyone else gets the same 404: strangers, no session, unknown and malformed ids, unattached uploads', async () => {
    const { a, c, conv } = await dm();
    const stranger = await signIn(app, 'st');
    const img = await upload(a, photo, 'p.jpg');
    const loose = await upload(a, photo, 'unsent.jpg');
    await send(a, conv, { attachmentIds: [img.id] });
    expect((await get(c, `/attachments/${img.id}`)).status).toBe(200);
    for (const [who, path] of [[stranger, `/attachments/${img.id}`], [stranger, `/attachments/${img.id}/thumb`], [a, `/attachments/${loose.id}`],
      [c, `/attachments/${randomUUID()}`], [c, '/attachments/not-a-uuid'], [c, '/attachments/..%2F..%2Fetc%2Fpasswd']] as const) {
      const res = await get(who, path);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
    expect((await get(null, `/attachments/${img.id}`)).status).toBe(401);
  });

  it('a member who left sees media sent before they left, and nothing sent after (404)', async () => {
    const [owner, leaver] = [await signIn(app, 'gl'), await signIn(app, 'gl')];
    const group = (await as(app, owner).post('/conversations', { title: 'Trip photos', memberIds: [leaver.id] })).body.conversation.id as string;
    const before = await upload(owner, photo, 'before.jpg');
    await send(owner, group, { attachmentIds: [before.id] });
    expect((await as(app, leaver).post(`/conversations/${group}/leave`)).status).toBe(200);
    const after = await upload(owner, photo, 'after.jpg');
    await send(owner, group, { attachmentIds: [after.id] });
    expect((await get(leaver, `/attachments/${before.id}`)).status).toBe(200);
    expect((await get(leaver, `/attachments/${after.id}`)).status).toBe(404);
    expect((await get(leaver, `/attachments/${after.id}/thumb`)).status).toBe(404);
  });

  it('a tombstoned message takes its media with it: 404 for everyone, and gone from history', async () => {
    const { a, c, conv } = await dm();
    const img = await upload(a, photo, 'oops.jpg');
    const m = (await send(a, conv, { body: 'wrong chat', attachmentIds: [img.id] })).body.message as { id: string };
    expect((await as(app, a).delete(`/conversations/${conv}/messages/${m.id}`)).body.message).toMatchObject({ body: null, attachments: [] });
    expect((await get(c, `/attachments/${img.id}`)).status).toBe(404);
    expect((await get(a, `/attachments/${img.id}`)).status).toBe(404);
  });

  it('a block refuses media in the DM like text', async () => {
    const { a, c, conv } = await dm();
    await as(app, c).put(`/blocks/${a.id}`);
    const img = await upload(a, photo, 'x.jpg');
    const res = await send(a, conv, { attachmentIds: [img.id] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('blocked');
    await as(app, c).delete(`/blocks/${a.id}`);
    expect((await send(a, conv, { attachmentIds: [img.id] })).status).toBe(201); // the refused send didn't use it up
  });
});

describe.skipIf(!apiUrl)('attachments over the socket', () => {
  const pool = appPool(apiUrl);
  afterAll(async () => {
    await pool.end();
  });

  it('message:new carries the attachment metadata', async () => {
    const { startTestServer } = await import('./sockets.js');
    const root = await mkdtemp(join(tmpdir(), 'chitthi-att-'));
    const server = await startTestServer(pool, apiUrl, { storage: new LocalStorage(root) });
    try {
      const [a, c] = [await signIn(server.url, 'sk'), await signIn(server.url, 'sk')];
      const conv = (await as(server.url, a).post('/conversations/direct', { userId: c.id })).body.conversation.id as string;
      const tab = await connect(server, c);
      const up = await request(server.url).post('/api/uploads').set('Cookie', a.cookie).set('Origin', WEB_ORIGIN).attach('file', b('%PDF-1.4\n'), 'plan.pdf');
      const pushed = next<MessageEvent>(tab, 'message:new', (e) => e.conversationId === conv);
      await as(server.url, a).post(`/conversations/${conv}/messages`, { clientMsgId: randomUUID(), attachmentIds: [up.body.attachment.id] });
      expect((await pushed).message.attachments).toEqual([up.body.attachment]);
      tab.disconnect();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
