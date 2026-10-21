import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { PresenceEvent } from '../src/realtime/presence.js';
import type { TypingEvent } from '../src/realtime/typing.js';
import { as, signIn, testApp, type Signed, type Target } from './apphelpers.js';
import { adminPool, appPool } from './dbhelpers.js';
import { connect, next, record, sleep, startTestServer, type TestServer } from './sockets.js';

const apiUrl = inject('apiDbUrl');
const ownerUrl = inject('dbUrl');

const say = (app: Target, u: Signed, conversationId: string, body = 'hello') =>
  as(app, u).post(`/conversations/${conversationId}/messages`, { clientMsgId: randomUUID(), body });

describe.skipIf(!apiUrl)('blocking: REST paths', () => {
  const pool = appPool(apiUrl);
  const admin = adminPool(ownerUrl);
  const app = testApp(pool, apiUrl);
  afterAll(async () => {
    await Promise.all([pool.end(), admin.end()]);
  });

  /** a and b with a DM and a group they share (owned by a), and a message from each. */
  async function setup() {
    const [a, b, c] = [await signIn(app, 'bl'), await signIn(app, 'bl'), await signIn(app, 'bl')];
    const dm = (await as(app, a).post('/conversations/direct', { userId: b.id })).body.conversation.id as string;
    const group = (await as(app, a).post('/conversations', { title: 'Hostel 4', memberIds: [b.id, c.id] })).body.conversation.id as string;
    const fromB = (await say(app, b, dm, 'before the block')).body.message as { id: string; seq: number };
    return { a, b, c, dm, group, fromB };
  }

  it('block, list, idempotent re-block, unblock; refuses yourself and unknown users', async () => {
    const { a, b } = await setup();
    expect((await as(app, a).put(`/blocks/${b.id}`)).status).toBe(201);
    expect((await as(app, a).put(`/blocks/${b.id}`)).status).toBe(200);
    const list = await as(app, a).get('/blocks');
    expect(list.body.blocked).toEqual([{ userId: b.id, handle: b.handle, displayName: b.handle, blockedAt: expect.any(String) }]);
    expect((await as(app, b).get('/blocks')).body.blocked).toEqual([]); // a block is the blocker's own list
    expect((await as(app, a).put(`/blocks/${a.id}`)).status).toBe(400);
    expect((await as(app, a).put(`/blocks/${randomUUID()}`)).status).toBe(404);
    expect((await as(app, a).put('/blocks/not-a-uuid')).status).toBe(404);
    expect((await as(app, a).delete(`/blocks/${b.id}`)).status).toBe(204);
    expect((await as(app, a).get('/blocks')).body.blocked).toEqual([]);
  });

  it('in their DM neither can send or edit (worded for each), deleting your own stays allowed, and seq stays gap-free', async () => {
    const { a, b, dm, fromB } = await setup();
    await as(app, a).put(`/blocks/${b.id}`);

    const fromBlocked = await say(app, b, dm);
    expect(fromBlocked.status).toBe(403);
    expect(fromBlocked.body.error).toMatchObject({ code: 'blocked', message: "You can't message this person." });
    const fromBlocker = await say(app, a, dm);
    expect(fromBlocker.body.error).toMatchObject({ code: 'blocked', message: 'You blocked this person. Unblock them to send messages.' });
    const edit = await as(app, b).patch(`/conversations/${dm}/messages/${fromB.id}`, { body: 'edited after' });
    expect(edit.body.error.code).toBe('blocked');
    expect((await as(app, b).delete(`/conversations/${dm}/messages/${fromB.id}`)).status).toBe(200);

    // History stays readable to both, and the conversation still opens.
    expect((await as(app, b).get(`/conversations/${dm}/messages`)).status).toBe(200);
    expect((await as(app, b).post('/conversations/direct', { userId: a.id })).status).toBe(200);
    expect((await as(app, a).get(`/conversations/${dm}`)).body.conversation.block).toBe('by_me');
    expect((await as(app, b).get(`/conversations/${dm}`)).body.conversation.block).toBe('by_them');

    await as(app, a).delete(`/blocks/${b.id}`);
    const after = await say(app, b, dm, 'after the unblock');
    expect(after.status).toBe(201);
    expect(after.body.message.seq).toBe(fromB.seq + 1); // the refused sends left no gap
    expect((await as(app, a).get(`/conversations/${dm}`)).body.conversation.block).toBeNull();
  });

  it('a new DM can\'t be started in either direction', async () => {
    const [a, b] = [await signIn(app, 'nb'), await signIn(app, 'nb')];
    await as(app, a).put(`/blocks/${b.id}`);
    const byBlocked = await as(app, b).post('/conversations/direct', { userId: a.id });
    expect(byBlocked.status).toBe(403);
    expect(byBlocked.body.error).toMatchObject({ code: 'blocked', message: "You can't message this person." });
    expect((await as(app, a).post('/conversations/direct', { userId: b.id })).body.error.code).toBe('blocked');
  });

  it("someone who blocked you can't be added to your groups or put in a new one; the reverse is your choice", async () => {
    const [a, b, c] = [await signIn(app, 'gb'), await signIn(app, 'gb'), await signIn(app, 'gb')];
    await as(app, b).put(`/blocks/${a.id}`); // b blocked a
    const create = await as(app, a).post('/conversations', { title: 'Trip', memberIds: [b.id, c.id] });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('blocked');
    const gid = (await as(app, a).post('/conversations', { title: 'Trip', memberIds: [c.id] })).body.conversation.id as string;
    const add = await as(app, a).post(`/conversations/${gid}/members`, { userId: b.id });
    expect(add.status).toBe(403);
    expect(add.body.error).toMatchObject({ code: 'blocked', message: "You can't add this person." });
    // c (no block) can add b; and b, who did the blocking, may still add a to a group of theirs.
    const cGroup = (await as(app, c).post('/conversations', { title: 'Mine', memberIds: [] })).body.conversation.id as string;
    expect((await as(app, c).post(`/conversations/${cGroup}/members`, { userId: b.id })).status).toBe(201);
    const bGroup = (await as(app, b).post('/conversations', { title: 'Theirs', memberIds: [a.id] })).status;
    expect(bGroup).toBe(201);
  });

  it('an existing group is unaffected: both stay members and still send and receive there', async () => {
    const { a, b, group } = await setup();
    await as(app, b).put(`/blocks/${a.id}`);
    expect((await say(app, a, group, 'group still works')).status).toBe(201);
    const fromB = await say(app, b, group, 'for everyone');
    expect(fromB.status).toBe(201);
    const page = await as(app, a).get(`/conversations/${group}/messages`);
    expect(page.body.messages.map((m: { body: string | null }) => m.body)).toEqual(expect.arrayContaining(['group still works', 'for everyone']));
  });

  it('search and exact lookup hide people who blocked you (and nobody else)', async () => {
    const [a, b] = [await signIn(app, 'sb'), await signIn(app, 'sb')];
    await as(app, b).put(`/blocks/${a.id}`);
    expect((await as(app, a).get(`/users?q=${b.handle}`)).body.users).toEqual([]);
    expect((await as(app, a).get(`/users/${b.handle}`)).status).toBe(404);
    expect((await as(app, b).get(`/users?q=${a.handle}`)).body.users).toHaveLength(1); // the blocker still finds them
    await as(app, b).delete(`/blocks/${a.id}`);
    expect((await as(app, a).get(`/users/${b.handle}`)).status).toBe(200);
  });

  it('every block route needs a session and an allowed Origin', async () => {
    const [a, b] = [await signIn(app, 'or'), await signIn(app, 'or')];
    const supertest = (await import('supertest')).default;
    expect((await supertest(app).get('/api/blocks')).status).toBe(401);
    expect((await supertest(app).put(`/api/blocks/${b.id}`).set('Cookie', a.cookie)).status).toBe(403);
  });
});

describe.skipIf(!apiUrl)('blocking: realtime paths', () => {
  const pool = appPool(apiUrl);
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(pool, apiUrl, { tuning: { presence: { graceMs: 300 }, typing: { ttlMs: 400, relayIntervalMs: 100 } } });
  });
  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  async function trio() {
    const [a, b, c] = [await signIn(server.url), await signIn(server.url), await signIn(server.url)];
    await as(server.url, a).post('/conversations/direct', { userId: b.id });
    const group = (await as(server.url, a).post('/conversations', { title: 'G', memberIds: [b.id, c.id] })).body.conversation.id as string;
    await server.realtime.idle();
    await sleep(60); // presence introductions are batched
    return { a, b, c, group };
  }

  it('a block hides presence both ways at once, snapshots leave them out, and unblocking restores it', async () => {
    const { a, b, c } = await trio();
    const [aTab, bTab] = await Promise.all([connect(server, a), connect(server, b)]);
    await sleep(50);
    const hiddenForB = next<{ users: PresenceEvent[] }>(bTab, 'presence:update', (u) => u.users.some((x) => x.userId === a.id));
    const hiddenForA = next<{ users: PresenceEvent[] }>(aTab, 'presence:update', (u) => u.users.some((x) => x.userId === b.id));
    await as(server.url, a).put(`/blocks/${b.id}`);
    expect((await hiddenForB).users).toEqual([{ userId: a.id, online: false, lastSeenAt: null }]);
    expect((await hiddenForA).users).toEqual([{ userId: b.id, online: false, lastSeenAt: null }]);

    // A fresh socket of b gets a snapshot without a (but with c, who shares the group).
    const cTab = await connect(server, c);
    const bSecond = (await import('./sockets.js')).socketFor(server, b);
    const snap = await next<{ users: PresenceEvent[] }>(bSecond, 'presence:snapshot');
    expect(snap.users.map((u) => u.userId).sort()).toEqual([c.id]);

    // a going offline (last seen) is not announced to b; c hears it.
    const bSaw = record<PresenceEvent>(bTab, 'presence');
    const cHears = next<PresenceEvent>(cTab, 'presence', (e) => e.userId === a.id && !e.online);
    aTab.disconnect();
    expect((await cHears).lastSeenAt).toEqual(expect.any(String));
    await sleep(100);
    expect(bSaw.filter((e) => e.userId === a.id)).toEqual([]);

    // Unblock: they share conversations, so b learns a's current presence again.
    const back = next<{ users: PresenceEvent[] }>(bTab, 'presence:update', (u) => u.users.some((x) => x.userId === a.id));
    await as(server.url, a).delete(`/blocks/${b.id}`);
    expect((await back).users[0]).toMatchObject({ userId: a.id, online: false, lastSeenAt: expect.any(String) });
    for (const s of [bTab, cTab, bSecond]) s.disconnect();
  });

  it('typing is not relayed across a block, even in a shared group', async () => {
    const { a, b, c, group } = await trio();
    await as(server.url, b).put(`/blocks/${a.id}`);
    const [aTab, bTab, cTab] = await Promise.all([connect(server, a), connect(server, b), connect(server, c)]);
    const bSees = record<TypingEvent>(bTab, 'typing');
    const aSees = record<TypingEvent>(aTab, 'typing');
    const cSeesA = next<TypingEvent>(cTab, 'typing', (e) => e.userId === a.id && e.typing);
    aTab.emit('typing', { conversationId: group, typing: true });
    await cSeesA;
    const cSeesB = next<TypingEvent>(cTab, 'typing', (e) => e.userId === b.id && e.typing);
    bTab.emit('typing', { conversationId: group, typing: true });
    await cSeesB;
    await sleep(500); // past the ttl, so any typing:false would have arrived too
    expect(bSees).toEqual([]);
    expect(aSees).toEqual([]);
    for (const s of [aTab, bTab, cTab]) s.disconnect();
  });

  it('a new member is not introduced to someone across a block', async () => {
    const [a, b, c] = [await signIn(server.url), await signIn(server.url), await signIn(server.url)];
    await as(server.url, c).put(`/blocks/${b.id}`);
    const [bTab, cTab] = await Promise.all([connect(server, b), connect(server, c)]);
    const bUpdates = record<{ users: PresenceEvent[] }>(bTab, 'presence:update');
    const cUpdates = record<{ users: PresenceEvent[] }>(cTab, 'presence:update');
    await as(server.url, a).post('/conversations', { title: 'Mixed', memberIds: [b.id, c.id] });
    await server.realtime.idle();
    await sleep(150);
    const seen = (u: { users: PresenceEvent[] }[]) => u.flatMap((x) => x.users.map((e) => e.userId));
    expect(seen(bUpdates)).toContain(a.id);
    expect(seen(bUpdates)).not.toContain(c.id);
    expect(seen(cUpdates)).toContain(a.id);
    expect(seen(cUpdates)).not.toContain(b.id);
    for (const s of [bTab, cTab]) s.disconnect();
  });
});
