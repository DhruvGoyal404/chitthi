import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { as, signIn, testApp } from './apphelpers.js';
import { appPool } from './dbhelpers.js';
import { WEB_ORIGIN } from './helpers.js';
import { MAX_ISSUES } from '../src/errors.js';

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

  // GHSA-mrhx-c7xc-m3w5: zod validated every element of an over-long array before its length,
  // so a 100 KB body of 50,000 bad ids made 50,000 issues (+28 MiB heap, a 4 MB answer).
  it('refuses an over-long array by its length, with a small answer', async () => {
    const { a, id } = await dm();
    const many = Array<number>(50_000).fill(1);
    for (const res of [
      await as(app, a).post('/conversations', { title: 'Huge', memberIds: many }),
      await as(app, a).post(`/conversations/${id}/messages`, { clientMsgId: randomUUID(), body: 'x', attachmentIds: many }),
    ]) {
      expect(res.status).toBe(400);
      expect(res.body.error.issues).toHaveLength(1);
      expect(res.body.error.issues[0].message).toMatch(/expected array to have <=/);
      expect(JSON.stringify(res.body).length).toBeLessThan(500);
    }
    // Wrong elements in an array within its bound: at most MAX_ISSUES come back.
    const wrong = await as(app, a).post('/conversations', { title: 'Wrong', memberIds: Array<number>(200).fill(1) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.issues).toHaveLength(MAX_ISSUES);
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

  it('serves /me, profile edits, handle search, conversation detail and inbox previews', async () => {
    const { a, b, id } = await dm();
    expect((await as(app, a).get('/me')).body.user).toEqual({ id: a.id, handle: a.handle, displayName: a.handle, avatarUrl: null });
    const renamed = await as(app, a).patch('/me', { displayName: '  Asha Rao  ' });
    expect(renamed.body.user.displayName).toBe('Asha Rao');
    expect((await as(app, a).patch('/me', { handle: 'Support' })).body.error.code).toBe('handle_reserved');
    expect((await as(app, a).patch('/me', { handle: b.handle.toUpperCase() })).status).toBe(409);
    expect((await as(app, a).patch('/me', {})).status).toBe(400);

    const found = await as(app, a).get(`/users?q=${b.handle.slice(0, 6)}`);
    expect(found.body.users.map((u: { id: string }) => u.id)).toContain(b.id);
    expect(found.body.users.map((u: { id: string }) => u.id)).not.toContain(a.id); // never yourself
    expect((await as(app, a).get('/users?q=a')).status).toBe(400);
    // "_" is a LIKE wildcard: a search for "q…_" must not also match "q…x…".
    const tag = randomUUID().replace(/-/g, '').slice(0, 6);
    await pool.query("INSERT INTO users (handle, display_name) VALUES ($1, 'x'), ($2, 'y')", [`q${tag}_lit`, `q${tag}xlit`]);
    const literal = await as(app, a).get(`/users?q=q${tag}_`);
    expect(literal.body.users.map((u: { handle: string }) => u.handle)).toEqual([`q${tag}_lit`]);
    expect((await as(app, a).get('/users?q=%25')).status).toBe(400);

    await as(app, b).post(`/conversations/${id}/messages`, { clientMsgId: randomUUID(), body: 'latest' });
    const detail = await as(app, a).get(`/conversations/${id}`);
    expect(detail.body.conversation).toMatchObject({ id, kind: 'direct', lastSeq: 1, myRole: 'member' });
    expect(detail.body.conversation.members.map((m: { userId: string }) => m.userId).sort()).toEqual([a.id, b.id].sort());
    const inbox = await as(app, a).get('/conversations');
    expect(inbox.body.conversations[0]).toMatchObject({
      id, unread: 1, peer: { id: b.id, handle: b.handle }, lastMessage: { seq: 1, body: 'latest', senderId: b.id, kind: 'text' },
    });
    const stranger = await signIn(app, 'rs');
    expect((await as(app, stranger).get(`/conversations/${id}`)).status).toBe(404);
  });

  it('tells the sender who received and read a group message, and when', async () => {
    const owner = await signIn(app, 'mi');
    const [x, y] = [await signIn(app, 'mx'), await signIn(app, 'my')];
    const gid = (await as(app, owner).post('/conversations', { title: 'Info', memberIds: [x.id, y.id] })).body.conversation.id as string;
    const sent = (await as(app, owner).post(`/conversations/${gid}/messages`, { clientMsgId: randomUUID(), body: 'who read me?' })).body.message;
    const path = `/conversations/${gid}/messages/${sent.id as string}/receipts`;
    expect((await as(app, owner).get(path)).body.receipts.map((r: { deliveredAt: unknown; readAt: unknown }) => [r.deliveredAt, r.readAt]))
      .toEqual([[null, null], [null, null]]);
    await pool.query('SELECT pg_sleep(0.02)');
    await as(app, x).post(`/conversations/${gid}/read`, { seq: sent.seq as number });
    const receipts = (await as(app, owner).get(path)).body.receipts as { userId: string; deliveredAt: string | null; readAt: string | null }[];
    const forX = receipts.find((r) => r.userId === x.id);
    expect(forX?.readAt).toEqual(expect.any(String));
    expect(forX?.deliveredAt).toBe(forX?.readAt); // reading implies delivery, at the same moment
    expect(receipts.find((r) => r.userId === y.id)).toMatchObject({ deliveredAt: null, readAt: null });
    expect((await as(app, x).get(path)).status).toBe(403); // only the sender
  });

});
