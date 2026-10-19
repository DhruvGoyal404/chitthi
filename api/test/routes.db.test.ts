import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { as, signIn, testApp } from './apphelpers.js';
import { appPool } from './dbhelpers.js';
import { WEB_ORIGIN } from './helpers.js';

const apiUrl = inject('apiDbUrl');

describe.skipIf(!apiUrl)('REST API (sends, edits, deletes, sync reads)', () => {
  const pool = appPool(apiUrl);
  const app = testApp(pool, apiUrl);
  afterAll(async () => {
    await pool.end();
  });

  async function dm() {
    const a = await signIn(app, 'ra');
    const b = await signIn(app, 'rb');
    const res = await as(app, a).post('/conversations/direct', { userId: b.id });
    expect(res.status).toBe(201);
    return { a, b, id: res.body.conversation.id as string };
  }

  it('sends idempotently: the response is the stored message with its seq (the ack)', async () => {
    const { a, b, id } = await dm();
    const clientMsgId = randomUUID();
    const first = await as(app, a).post(`/conversations/${id}/messages`, { clientMsgId, body: 'namaste' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ duplicate: false, message: { seq: 1, changeSeq: 1, body: 'namaste', senderId: a.id, clientMsgId } });
    const retry = await as(app, a).post(`/conversations/${id}/messages`, { clientMsgId, body: 'namaste' });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ...first.body, duplicate: true });
    const clash = await as(app, a).post(`/conversations/${id}/messages`, { clientMsgId, body: 'different' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('idempotency_conflict');
    expect((await as(app, b).post('/conversations/direct', { userId: a.id })).status).toBe(200); // same DM
  });

  it('edits and deletes through REST, scoped to the conversation in the path', async () => {
    const { a, b, id } = await dm();
    const sent = (await as(app, a).post(`/conversations/${id}/messages`, { clientMsgId: randomUUID(), body: 'v1' })).body.message;
    const edited = await as(app, a).patch(`/conversations/${id}/messages/${sent.id as string}`, { body: 'v2' });
    expect(edited.status).toBe(200);
    expect(edited.body.message).toMatchObject({ seq: 1, changeSeq: 2, body: 'v2' });
    expect((await as(app, b).patch(`/conversations/${id}/messages/${sent.id as string}`, { body: 'x' })).status).toBe(403);
    // The same message id under another conversation is not found.
    const other = await dm();
    expect((await as(app, a).delete(`/conversations/${other.id}/messages/${sent.id as string}`)).status).toBe(404);
    const deleted = await as(app, a).delete(`/conversations/${id}/messages/${sent.id as string}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.message).toMatchObject({ seq: 1, changeSeq: 3, body: null });
    expect(deleted.body.message.deletedAt).toEqual(expect.any(String));
  });

  it('serves history, seq catch-up, change catch-up, the inbox and read markers', async () => {
    const { a, b, id } = await dm();
    for (let i = 1; i <= 5; i++) await as(app, i % 2 ? a : b).post(`/conversations/${id}/messages`, { clientMsgId: randomUUID(), body: `m${String(i)}` });
    const page = await as(app, b).get(`/conversations/${id}/messages?limit=2`);
    expect(page.body.messages.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
    expect(page.body.hasMore).toBe(true);
    const before = await as(app, b).get(`/conversations/${id}/messages?before=4&limit=2`);
    expect(before.body.messages.map((m: { seq: number }) => m.seq)).toEqual([2, 3]);
    const after = await as(app, b).get(`/conversations/${id}/messages?after=3`);
    expect(after.body.messages.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
    const changes = await as(app, b).get(`/conversations/${id}/changes?after=4`);
    expect(changes.body).toMatchObject({ hasMore: false, nextCursor: 5 });

    const inbox = await as(app, b).get('/conversations');
    expect(inbox.body.conversations[0]).toMatchObject({ id, lastSeq: 5, changeSeq: 5, lastReadSeq: 4, unread: 1 });
    const read = await as(app, b).post(`/conversations/${id}/read`, { seq: 5 });
    expect(read.body).toEqual({ lastReadSeq: 5, lastDeliveredSeq: 5 });
    expect((await as(app, b).post(`/conversations/${id}/read`, { seq: 2 })).body.lastReadSeq).toBe(5);
  });

  it('manages groups over REST', async () => {
    const owner = await signIn(app, 'go');
    const [x, y] = [await signIn(app, 'gx'), await signIn(app, 'gy')];
    const g = await as(app, owner).post('/conversations', { title: 'Book club', memberIds: [x.id] });
    expect(g.status).toBe(201);
    const gid = g.body.conversation.id as string;
    expect((await as(app, owner).post(`/conversations/${gid}/members`, { userId: y.id })).body).toEqual({ joinedSeq: 2 });
    expect((await as(app, owner).delete(`/conversations/${gid}/members/${y.id}`)).body).toEqual({ leftSeq: 3 });
    expect((await as(app, x).post(`/conversations/${gid}/leave`)).body).toEqual({ leftSeq: 4 });
    const found = await as(app, owner).get(`/users/${x.handle.toUpperCase()}`);
    expect(found.body.user).toMatchObject({ id: x.id, handle: x.handle });
  });

  it('rejects bad input, strangers, missing sessions and foreign origins', async () => {
    const { a, id } = await dm();
    const stranger = await signIn(app, 'rs');
    const send = (u: typeof a, body: object) => as(app, u).post(`/conversations/${id}/messages`, body);
    expect((await send(a, { clientMsgId: 'nope', body: 'x' })).status).toBe(400);
    expect((await send(a, { clientMsgId: randomUUID(), body: '' })).status).toBe(400);
    expect((await send(a, { clientMsgId: randomUUID(), body: 'x'.repeat(4001) })).status).toBe(400);
    expect((await send(stranger, { clientMsgId: randomUUID(), body: 'hi' })).status).toBe(404);
    expect((await as(app, stranger).get(`/conversations/${id}/messages`)).status).toBe(404);
    expect((await as(app, a).get('/conversations/not-a-uuid/messages')).status).toBe(404);
    expect((await as(app, a).get(`/conversations/${id}/messages?before=1&after=1`)).status).toBe(400);
    expect((await request(app).get('/api/conversations')).status).toBe(401);
    const foreign = await request(app).post(`/api/conversations/${id}/messages`).set('Cookie', a.cookie).set('Origin', 'http://evil.example')
      .send({ clientMsgId: randomUUID(), body: 'csrf' });
    expect(foreign.status).toBe(403);
    expect(WEB_ORIGIN).toBe('http://localhost:5175');
  });

  it('rate-limits sends per user', async () => {
    const limited = testApp(pool, apiUrl, { auth: { points: 100, duration: 60 }, send: { points: 2, duration: 60 } });
    const a = await signIn(limited, 'rl');
    const b = await signIn(limited, 'rl');
    const id = (await as(limited, a).post('/conversations/direct', { userId: b.id })).body.conversation.id as string;
    const send = () => as(limited, a).post(`/conversations/${id}/messages`, { clientMsgId: randomUUID(), body: 'x' });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(429);
  });
});
