import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { ReceiptEvent } from '../src/realtime/receipts.js';
import type { TypingEvent } from '../src/realtime/typing.js';
import { as, signIn, type Signed } from './apphelpers.js';
import { appPool } from './dbhelpers.js';
import { connect, disconnected, next, record, sleep, startTestServer, type TestServer } from './sockets.js';

const apiUrl = inject('apiDbUrl');

/** Emits with an acknowledgement and resolves with the server's answer. */
const ask = (s: Socket, event: string, payload: unknown) =>
  new Promise<Record<string, unknown>>((resolve) => { s.emit(event, payload, (r: Record<string, unknown>) => { resolve(r); }); });

describe.skipIf(!apiUrl)('receipts, delivered-acks and typing', () => {
  const pool = appPool(apiUrl);
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(pool, apiUrl, { tuning: { typing: { ttlMs: 400, relayIntervalMs: 200 } } });
  });
  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  async function dm(): Promise<{ a: Signed; b: Signed; id: string }> {
    const [a, b] = [await signIn(server.url), await signIn(server.url)];
    const id = (await as(server.url, a).post('/conversations/direct', { userId: b.id })).body.conversation.id as string;
    return { a, b, id };
  }
  const send = (u: Signed, id: string, body = 'hi') => as(server.url, u).post(`/conversations/${id}/messages`, { clientMsgId: randomUUID(), body });

  it('a send moves the sender\'s markers with one read:updated (it implies delivered); no separate delivered:updated', async () => {
    const { a, b, id } = await dm();
    const [as1, bs1] = await Promise.all([connect(server, a), connect(server, b)]);
    const delivered = record<ReceiptEvent>(bs1, 'delivered:updated');
    const read = next<ReceiptEvent>(bs1, 'read:updated', (e) => e.userId === a.id);
    const ownTab = next<ReceiptEvent>(as1, 'read:updated', (e) => e.userId === a.id);
    const seq = (await send(a, id)).body.message.seq as number;
    expect(await read).toEqual({ conversationId: id, userId: a.id, seq });
    expect((await ownTab).seq).toBe(seq);
    await server.realtime.idle();
    expect(delivered).toEqual([]);
    for (const s of [as1, bs1]) s.disconnect();
  });

  it('pushes read:updated to the reader\'s other tabs and to the other member', async () => {
    const { a, b, id } = await dm();
    await send(a, id);
    await send(a, id);
    const [as1, bs1, bs2] = await Promise.all([connect(server, a), connect(server, b), connect(server, b)]);
    const got = [as1, bs2].map((s) => next<ReceiptEvent>(s, 'read:updated', (e) => e.userId === b.id));
    await as(server.url, b).post(`/conversations/${id}/read`, { seq: 2 });
    for (const e of await Promise.all(got)) expect(e).toEqual({ conversationId: id, userId: b.id, seq: 2 });

    // Sending advances the sender's own marker (decision 3), which is a receipt too.
    const own = next<ReceiptEvent>(as1, 'read:updated', (e) => e.userId === b.id && e.seq === 3);
    await send(b, id);
    expect(await own).toEqual({ conversationId: id, userId: b.id, seq: 3 });
    for (const s of [as1, bs1, bs2]) s.disconnect();
  });

  it('takes delivered-acks over the socket: forward-only, clamped, membership-checked', async () => {
    const { a, b, id } = await dm();
    await send(a, id);
    await send(a, id);
    const [as1, bs1] = await Promise.all([connect(server, a), connect(server, b)]);
    const seen = next<ReceiptEvent>(as1, 'delivered:updated', (e) => e.userId === b.id);
    expect(await ask(bs1, 'delivered', { conversationId: id, seq: 2 })).toEqual({ ok: true, lastReadSeq: 0, lastDeliveredSeq: 2 });
    expect(await seen).toEqual({ conversationId: id, userId: b.id, seq: 2 });
    expect(await ask(bs1, 'delivered', { conversationId: id, seq: 1 })).toMatchObject({ ok: true, lastDeliveredSeq: 2 });
    expect(await ask(bs1, 'delivered', { conversationId: id, seq: 999 })).toMatchObject({ ok: true, lastDeliveredSeq: 2 });

    const stranger = await connect(server, await signIn(server.url));
    expect(await ask(stranger, 'delivered', { conversationId: id, seq: 1 })).toEqual({ ok: false, code: 'not_found' });
    for (const s of [as1, bs1, stranger]) s.disconnect();
  });

  it('relays typing to the other member only, throttled, and expires it on its own', async () => {
    const { a, b, id } = await dm();
    const [a1, a2, b1] = await Promise.all([connect(server, a), connect(server, a), connect(server, b)]);
    const aOther = record<TypingEvent>(a2, 'typing');
    const atB = record<TypingEvent>(b1, 'typing');

    expect(await ask(a1, 'typing', { conversationId: id, typing: true })).toEqual({ ok: true });
    await ask(a1, 'typing', { conversationId: id, typing: true }); // within relayIntervalMs: not relayed again
    await sleep(100);
    expect(atB).toEqual([{ conversationId: id, userId: a.id, typing: true, ttlMs: 400 }]);
    expect(aOther).toEqual([]); // never echoed to the typist's own tabs

    // No refresh within ttlMs: the server relays typing:false by itself.
    await next(b1, 'typing', (e: TypingEvent) => !e.typing, 2_000);
    expect(atB.map((e) => e.typing)).toEqual([true, false]);

    // A tab that goes away mid-typing stops typing too.
    await ask(a1, 'typing', { conversationId: id, typing: true });
    const stopped = next(b1, 'typing', (e: TypingEvent) => !e.typing, 2_000);
    a1.disconnect();
    await stopped;
    for (const s of [a2, b1]) s.disconnect();
  });

  it('rejects typing from a non-member and from a former member, and relays nothing', async () => {
    const { a, b, id } = await dm();
    const owner = await signIn(server.url);
    const gid = (await as(server.url, owner).post('/conversations', { title: 'T', memberIds: [a.id] })).body.conversation.id as string;
    const [as1, bs1, os1] = await Promise.all([connect(server, a), connect(server, b), connect(server, owner)]);
    const atA = record<TypingEvent>(as1, 'typing');
    const atOwner = record<TypingEvent>(os1, 'typing');

    expect(await ask(bs1, 'typing', { conversationId: gid, typing: true })).toEqual({ ok: false, code: 'not_found' });
    await as(server.url, a).post(`/conversations/${gid}/leave`);
    expect(await ask(as1, 'typing', { conversationId: gid, typing: true })).toEqual({ ok: false, code: 'read_only' });
    expect(await ask(bs1, 'typing', { conversationId: id, typing: true })).toEqual({ ok: true }); // the DM is fine
    await sleep(100);
    expect(atOwner).toEqual([]);
    expect(atA.map((e) => e.conversationId)).toEqual([id]);
    for (const s of [as1, bs1, os1]) s.disconnect();
  });

  it('disconnects on malformed inbound payloads and on inbound floods', async () => {
    const u = await signIn(server.url);
    const s1 = await connect(server, u);
    const gone1 = disconnected(s1);
    s1.emit('typing', { conversationId: 'not-a-uuid', typing: 'yes' });
    expect(await gone1).toBe('io server disconnect');

    const flood = await startTestServer(pool, apiUrl, { realtime: { rateLimit: { burst: 3, perSecond: 0.1 } } });
    try {
      const s2 = await connect(flood, u);
      const gone2 = disconnected(s2);
      for (let i = 0; i < 5; i++) s2.emit('delivered', { conversationId: randomUUID(), seq: 0 });
      expect(await gone2).toBe('io server disconnect');
    } finally {
      await flood.close();
    }
  });
});
