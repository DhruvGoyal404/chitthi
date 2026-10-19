import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { MessageEvent } from '../src/realtime/fanout.js';
import { as, signIn } from './apphelpers.js';
import { appPool } from './dbhelpers.js';
import { connect, next, record, sleep, startTestServer, type TestServer } from './sockets.js';

const apiUrl = inject('apiDbUrl');

describe.skipIf(!apiUrl)('message fan-out', () => {
  const pool = appPool(apiUrl);
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(pool, apiUrl);
  });
  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it('pushes a committed message, with its seq, to every tab of every member and nobody else', async () => {
    const [a, b, stranger] = [await signIn(server.url), await signIn(server.url), await signIn(server.url)];
    const id = (await as(server.url, a).post('/conversations/direct', { userId: b.id })).body.conversation.id as string;
    const [a1, b1, b2, s1] = await Promise.all([connect(server, a), connect(server, b), connect(server, b), connect(server, stranger)]);
    const strangerSaw = record(s1, 'message:new');
    const got = [a1, b1, b2].map((s) => next<MessageEvent>(s, 'message:new', (e) => e.conversationId === id));

    const sent = await as(server.url, a).post(`/conversations/${id}/messages`, { clientMsgId: randomUUID(), body: 'pushed' });
    const events = await Promise.all(got);
    for (const e of events) {
      expect(e).toMatchObject({ conversationId: id, seq: 1, changeSeq: 1, message: { id: sent.body.message.id, seq: 1, body: 'pushed', senderId: a.id } });
    }
    await server.realtime.idle();
    await sleep(100);
    expect(strangerSaw).toEqual([]);
    for (const s of [a1, b1, b2, s1]) s.disconnect();
  });

  it('pushes edits and deletes as message:updated, and a tombstone never carries the body', async () => {
    const [a, b] = [await signIn(server.url), await signIn(server.url)];
    const id = (await as(server.url, a).post('/conversations/direct', { userId: b.id })).body.conversation.id as string;
    const bs = await connect(server, b);
    const raw: string[] = [];
    bs.onAny((_event: string, payload: unknown) => raw.push(JSON.stringify(payload)));
    const sent = (await as(server.url, a).post(`/conversations/${id}/messages`, { clientMsgId: randomUUID(), body: 'secret-v1' })).body.message;
    await next(bs, 'message:new');

    const edited = next<MessageEvent>(bs, 'message:updated');
    await as(server.url, a).patch(`/conversations/${id}/messages/${sent.id as string}`, { body: 'secret-v2' });
    expect(await edited).toMatchObject({ seq: 1, changeSeq: 2, message: { body: 'secret-v2' } });

    const deleted = next<MessageEvent>(bs, 'message:updated');
    await as(server.url, a).delete(`/conversations/${id}/messages/${sent.id as string}`);
    const tomb = await deleted;
    expect(tomb).toMatchObject({ seq: 1, changeSeq: 3, message: { body: null } });
    expect(JSON.stringify(tomb)).not.toContain('secret');
    bs.disconnect();
  });

  it('respects membership windows: nothing before joining, nothing after removal', async () => {
    const [owner, late] = [await signIn(server.url), await signIn(server.url)];
    const gid = (await as(server.url, owner).post('/conversations', { title: 'Windows', memberIds: [] })).body.conversation.id as string;
    const ls = await connect(server, late);
    const lateSaw = record<MessageEvent>(ls, 'message:new');
    const send = (body: string) => as(server.url, owner).post(`/conversations/${gid}/messages`, { clientMsgId: randomUUID(), body });

    await send('before join');                                                       // seq 2
    await as(server.url, owner).post(`/conversations/${gid}/members`, { userId: late.id }); // seq 3
    await send('while member');                                                      // seq 4
    await as(server.url, owner).delete(`/conversations/${gid}/members/${late.id}`);  // seq 5
    await send('after removal');                                                     // seq 6
    await server.realtime.idle();
    await sleep(150);
    expect(lateSaw.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(lateSaw.map((e) => e.message.body ?? e.message.meta?.event)).toEqual(['member_added', 'while member', 'member_removed']);
    ls.disconnect();
  });
});
