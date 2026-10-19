import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { MessageEvent } from '../src/realtime/fanout.js';
import type { PresenceEvent } from '../src/realtime/presence.js';
import type { TypingEvent } from '../src/realtime/typing.js';
import { as, signIn, type Signed } from './apphelpers.js';
import { adminPool, appPool } from './dbhelpers.js';
import { connect, next, record, sleep, startTestServer, waitUntil, type TestServer } from './sockets.js';

// End-to-end delivery scenarios: the real API process (REST + Socket.IO + LISTEN), real Postgres
// as chitthi_api, real socket.io-client sockets. Messages are only ever written over REST.
const apiUrl = inject('apiDbUrl');
const ownerUrl = inject('dbUrl');

type Row = { seq: number; changeSeq: number; body: string | null; id: string; deletedAt: string | null };

describe.skipIf(!apiUrl)('real-time delivery, end to end', () => {
  const pool = appPool(apiUrl, 20);
  const admin = adminPool(ownerUrl);
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(pool, apiUrl, {
      tuning: { presence: { graceMs: 500 }, typing: { ttlMs: 400, relayIntervalMs: 100 } },
      listenerBackoff: { minMs: 50, maxMs: 200 },
    });
  });
  afterAll(async () => {
    await server.close();
    await Promise.all([pool.end(), admin.end()]);
  });

  const api = (u: Signed) => as(server.url, u);
  const send = async (u: Signed, conversationId: string, body: string) => {
    const res = await api(u).post(`/conversations/${conversationId}/messages`, { clientMsgId: randomUUID(), body });
    if (res.status !== 201) throw new Error(`send failed: ${String(res.status)}`);
    return res.body.message as Row;
  };
  async function dm(): Promise<{ a: Signed; b: Signed; id: string }> {
    const [a, b] = [await signIn(server.url), await signIn(server.url)];
    const id = (await api(a).post('/conversations/direct', { userId: b.id })).body.conversation.id as string;
    return { a, b, id };
  }
  /** All `message:new` seqs a socket received for one conversation, in arrival order. */
  const seqsOf = (events: MessageEvent[], id: string) => events.filter((e) => e.conversationId === id).map((e) => e.seq);

  it('two users with two tabs each: every tab sees every message once, in seq order', async () => {
    const { a, b, id } = await dm();
    const tabs = await Promise.all([connect(server, a), connect(server, a), connect(server, b), connect(server, b)]);
    const seen = tabs.map((t) => record<MessageEvent>(t, 'message:new'));
    // Interleaved, concurrent sends from both users.
    await Promise.all(Array.from({ length: 20 }, (_, i) => send(i % 2 ? a : b, id, `m${String(i)}`)));
    await waitUntil(() => seen.every((s) => s.length === 20), 5_000, 'all tabs to receive 20');
    for (const s of seen) expect(seqsOf(s, id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const t of tabs) t.disconnect();
  });

  it('an offline recipient catches up exactly over REST: new messages, edits and deletes', async () => {
    const { a, b, id } = await dm();
    const first = await send(a, id, 'before going offline');
    // B saw seq 1 / change 1, then went offline. Meanwhile A sends, edits and deletes.
    const sent: Row[] = [];
    for (let i = 0; i < 6; i++) sent.push(await send(a, id, `while away ${String(i)}`));
    await api(a).patch(`/conversations/${id}/messages/${first.id}`, { body: 'edited while away' });
    await api(a).delete(`/conversations/${id}/messages/${sent[2]?.id ?? ''}`);

    const bySeq = await api(b).get(`/conversations/${id}/messages?after=1`);
    expect(bySeq.body.messages.map((m: Row) => m.seq)).toEqual([2, 3, 4, 5, 6, 7]);
    const changes = await api(b).get(`/conversations/${id}/changes?after=1`);
    const changed = changes.body.messages as Row[];
    // Every change after B's cursor exactly once, in change order, ending at the head.
    expect(changed.map((m) => m.changeSeq)).toEqual([...changed.map((m) => m.changeSeq)].sort((x, y) => x - y));
    expect(changed.find((m) => m.seq === 1)?.body).toBe('edited while away');
    expect(changed.find((m) => m.seq === 4)).toMatchObject({ body: null, deletedAt: expect.any(String) });
    expect(changes.body.nextCursor).toBe(9); // 7 inserts + 1 edit + 1 delete
    const inbox = await api(b).get('/conversations');
    expect(inbox.body.conversations[0]).toMatchObject({ lastSeq: 7, changeSeq: 9, unread: 6 }); // the deleted one doesn't count
  });

  it('repairs an artificial gap: a dropped push is detected on the next one and fetched over REST', async () => {
    const { a, b, id } = await dm();
    const tab = await connect(server, b);
    const got: MessageEvent[] = [];
    let dropped = false;
    tab.on('message:new', (e: MessageEvent) => {
      if (!dropped && e.seq === 3) { dropped = true; return; } // the network ate it
      got.push(e);
    });
    for (let i = 1; i <= 5; i++) await send(a, id, `m${String(i)}`);
    await waitUntil(() => got.length === 4, 5_000, '4 pushes');
    const seqs = got.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 4, 5]);
    const gapAt = seqs.findIndex((s, i) => i > 0 && s !== (seqs[i - 1] ?? 0) + 1);
    expect(gapAt).toBe(2);
    const repair = await api(b).get(`/conversations/${id}/messages?after=${String(seqs[gapAt - 1])}`);
    const repaired = [...new Set([...seqs, ...repair.body.messages.map((m: Row) => m.seq)])].sort((x, y) => x - y);
    expect(repaired).toEqual([1, 2, 3, 4, 5]);
    tab.disconnect();
  });

  it('stops pushing to a member the moment they are removed, mid-stream', async () => {
    const [owner, c] = [await signIn(server.url), await signIn(server.url)];
    const gid = (await api(owner).post('/conversations', { title: 'Stream', memberIds: [c.id] })).body.conversation.id as string;
    const cTab = await connect(server, c);
    const ownerTab = await connect(server, owner);
    const atC = record<MessageEvent>(cTab, 'message:new');
    const atOwner = record<MessageEvent>(ownerTab, 'message:new');

    let removedAt = 0;
    const stream = (async () => {
      for (let i = 0; i < 30; i++) {
        await send(owner, gid, `tick ${String(i)}`);
        if (i === 12) removedAt = (await api(owner).delete(`/conversations/${gid}/members/${c.id}`)).body.leftSeq as number;
      }
    })();
    await stream;
    // The owner's tab connected after group_created (seq 1): 30 ticks + the removal notice = seq 2..32.
    await waitUntil(() => seqsOf(atOwner, gid).length === 31, 5_000, 'owner to see everything');
    expect(seqsOf(atOwner, gid)).toEqual(Array.from({ length: 31 }, (_, i) => i + 2));
    await server.realtime.idle();
    await sleep(100);
    const cSeqs = seqsOf(atC, gid);
    expect(removedAt).toBeGreaterThan(1);
    expect(Math.max(...cSeqs)).toBe(removedAt); // the last push C got is their own removal notice
    expect(atC.at(-1)?.message.meta?.event).toBe('member_removed');
    expect(cSeqs).toEqual(Array.from({ length: removedAt - 1 }, (_, i) => i + 2)); // 2..left_seq, none after
    for (const t of [cTab, ownerTab]) t.disconnect();
  });

  it('propagates edits and deletes; a deleted body is never sent again, to anyone', async () => {
    const { a, b, id } = await dm();
    const tab = await connect(server, b);
    const frames: string[] = [];
    tab.onAny((_e: string, p: unknown) => frames.push(JSON.stringify(p)));
    const m = await send(a, id, 'SECRET-PLAN-v1');
    await next(tab, 'message:new');
    const edited = next<MessageEvent>(tab, 'message:updated');
    await api(a).patch(`/conversations/${id}/messages/${m.id}`, { body: 'SECRET-PLAN-v2' });
    expect((await edited).message.body).toBe('SECRET-PLAN-v2');

    const cut = frames.length;
    const deleted = next<MessageEvent>(tab, 'message:updated');
    await api(a).delete(`/conversations/${id}/messages/${m.id}`);
    expect((await deleted).message).toMatchObject({ body: null, deletedAt: expect.any(String) });
    expect(frames.slice(cut).join('')).not.toContain('SECRET-PLAN');

    // Late readers (REST history, change catch-up, a fresh tab) only ever see the tombstone.
    const late = await connect(server, b);
    const lateFrames: string[] = [];
    late.onAny((_e: string, p: unknown) => lateFrames.push(JSON.stringify(p)));
    const history = await api(b).get(`/conversations/${id}/messages`);
    const changes = await api(b).get(`/conversations/${id}/changes?after=0`);
    expect(JSON.stringify(history.body) + JSON.stringify(changes.body) + lateFrames.join('')).not.toContain('SECRET-PLAN');
    for (const t of [tab, late]) t.disconnect();
  });

  it('delivers a 4000-emoji message (16 KB of UTF-8; NOTIFY only ever carries ids)', async () => {
    const { a, b, id } = await dm();
    const tab = await connect(server, b);
    const body = '🪷'.repeat(4000);
    expect(Buffer.byteLength(body, 'utf8')).toBe(16_000); // twice the 8000-byte NOTIFY payload limit
    const pushed = next<MessageEvent>(tab, 'message:new');
    await send(a, id, body);
    expect((await pushed).message.body).toBe(body);
    tab.disconnect();
  });

  it('rejects typing from a non-member (end to end) and relays a member\'s typing', async () => {
    const { a, b, id } = await dm();
    const outsider = await signIn(server.url);
    const [aTab, bTab, oTab] = await Promise.all([connect(server, a), connect(server, b), connect(server, outsider)]);
    const atA = record<TypingEvent>(aTab, 'typing');
    const ask = (s: Socket, p: unknown) => new Promise((r) => { s.emit('typing', p, r); });
    expect(await ask(oTab, { conversationId: id, typing: true })).toEqual({ ok: false, code: 'not_found' });
    expect(await ask(bTab, { conversationId: id, typing: true })).toEqual({ ok: true });
    await sleep(100);
    expect(atA.map((e) => [e.userId, e.typing])).toEqual([[b.id, true]]);
    for (const t of [aTab, bTab, oTab]) t.disconnect();
  });

  it('presence with two tabs and the grace period (end to end)', async () => {
    const { a, b } = await dm();
    const watcher = await connect(server, b);
    const seen = record<PresenceEvent>(watcher, 'presence');
    const [t1, t2] = await Promise.all([connect(server, a), connect(server, a)]);
    t1.disconnect();
    await sleep(700);
    expect(seen.map((e) => e.online)).toEqual([true]);
    t2.disconnect();
    await next(watcher, 'presence', (e: PresenceEvent) => !e.online, 3_000);
    watcher.disconnect();
  });

  it('when the LISTEN connection dies, clients get resync and can recover what was missed', async () => {
    const { a, b, id } = await dm();
    const tab = await connect(server, b);
    const resync = next(tab, 'resync', () => true, 10_000);
    const oldPid = server.listener.backendPid;
    await admin.query('SELECT pg_terminate_backend($1)', [oldPid]);
    // Committed while the listener is down or reconnecting: its NOTIFY is lost for good.
    const lost = await send(a, id, 'sent during the outage');
    await resync;
    await waitUntil(() => server.listener.listening && server.listener.backendPid !== oldPid, 5_000, 'listener back');
    const caught = await api(b).get(`/conversations/${id}/messages?after=0`);
    expect(caught.body.messages.map((m: Row) => m.id)).toContain(lost.id);
    // And pushes work again afterwards.
    const after = next<MessageEvent>(tab, 'message:new', (e) => e.message.body === 'after recovery');
    await send(a, id, 'after recovery');
    await after;
    tab.disconnect();
  });

  it('200 sockets: commit-to-delivery latency', async () => {
    const members = await Promise.all(Array.from({ length: 100 }, () => signIn(server.url, 'lat')));
    const sender = await signIn(server.url, 'lat');
    const gid = (await api(sender).post('/conversations', { title: 'Latency', memberIds: members.map((m) => m.id) })).body.conversation.id as string;
    const sockets = (await Promise.all(members.map(async (m) => [await connect(server, m), await connect(server, m)]))).flat();
    expect(sockets).toHaveLength(200);

    const N = 25;
    const sentAt = new Map<number, number>();
    const ackAt = new Map<number, number>();
    const latencies: number[] = [];
    const commitLatencies: number[] = [];
    let delivered = 0;
    for (const s of sockets) {
      s.on('message:new', (e: MessageEvent) => {
        if (e.conversationId !== gid) return;
        const now = performance.now();
        const t0 = sentAt.get(e.seq);
        const t1 = ackAt.get(e.seq);
        if (t0 !== undefined) latencies.push(now - t0);
        if (t1 !== undefined) commitLatencies.push(now - t1);
        delivered++;
      });
    }
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const seq = i + 2; // seq 1 is group_created
      sentAt.set(seq, t0);
      await send(sender, gid, `ping ${String(i)}`);
      ackAt.set(seq, performance.now());
      await sleep(40);
    }
    await waitUntil(() => delivered === N * 200, 20_000, 'every socket to receive every message');

    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((x, y) => x - y);
      return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN) * 10) / 10;
    };
    const report = {
      sockets: 200, messages: N, deliveries: delivered,
      sendToDeliveryMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99) },
      // Measured from the REST response (commit acknowledged); negative = pushed before the response arrived.
      ackToDeliveryMs: { p50: pct(commitLatencies, 50), p95: pct(commitLatencies, 95) },
    };
    process.stderr.write(`\nLATENCY ${JSON.stringify(report)}\n`);
    expect(report.sendToDeliveryMs.p95).toBeLessThan(1_000);
    for (const s of sockets) s.disconnect();
  }, 120_000);
});
