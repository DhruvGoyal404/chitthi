import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { PresenceEvent } from '../src/realtime/presence.js';
import { as, signIn, type Signed } from './apphelpers.js';
import { adminPool, appPool } from './dbhelpers.js';
import { connect, next, record, sleep, socketFor, startTestServer, waitUntil, type TestServer } from './sockets.js';

const apiUrl = inject('apiDbUrl');
const ownerUrl = inject('dbUrl');
const GRACE = 600;

describe.skipIf(!apiUrl)('presence', () => {
  const pool = appPool(apiUrl);
  const admin = adminPool(ownerUrl);
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(pool, apiUrl, { tuning: { presence: { graceMs: GRACE } } });
  });
  afterAll(async () => {
    await server.close();
    await Promise.all([pool.end(), admin.end()]);
  });

  async function pair(): Promise<[Signed, Signed]> {
    const [a, b] = [await signIn(server.url), await signIn(server.url)];
    await as(server.url, a).post('/conversations/direct', { userId: b.id });
    // Let the membership presence exchange finish before the test starts recording.
    await server.realtime.idle();
    return [a, b];
  }

  it('counts tabs: online once, still online after one of two tabs closes, offline only after the grace', async () => {
    const [a, b] = await pair();
    const watcher = await connect(server, b);
    const seen = record<PresenceEvent>(watcher, 'presence');

    const tab1 = await connect(server, a);
    const tab2 = await connect(server, a);
    await sleep(100);
    expect(seen).toEqual([{ userId: a.id, online: true, lastSeenAt: null }]); // one event for two tabs

    tab1.disconnect();
    await sleep(GRACE + 300);
    expect(seen).toHaveLength(1); // the other tab keeps A online
    expect(server.presence.isOnline(a.id)).toBe(true);

    const closedAt = Date.now();
    tab2.disconnect();
    await sleep(GRACE / 2);
    expect(seen).toHaveLength(1); // still within the grace
    const offline = await next<PresenceEvent>(watcher, 'presence', (e) => !e.online, GRACE * 3);
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(GRACE - 50);
    expect(offline.userId).toBe(a.id);
    expect(offline.lastSeenAt).toEqual(expect.any(String));
    const { rows: [row] } = await admin.query<{ last_seen_at: Date }>('SELECT last_seen_at FROM users WHERE id = $1', [a.id]);
    expect(row?.last_seen_at.toISOString()).toBe(offline.lastSeenAt);
    watcher.disconnect();
  });

  it('a reconnect within the grace period produces no events at all (no flicker on reload)', async () => {
    const [a, b] = await pair();
    const watcher = await connect(server, b);
    const tab = await connect(server, a);
    await sleep(100);
    const seen = record<PresenceEvent>(watcher, 'presence');
    tab.disconnect();
    await sleep(GRACE / 3);
    const again = await connect(server, a);
    await sleep(GRACE + 300);
    expect(seen).toEqual([]);
    expect(server.presence.isOnline(a.id)).toBe(true);
    for (const s of [watcher, again]) s.disconnect();
  });

  it('introduces two online users to each other when they start a DM, and a new group member to the group', async () => {
    const [a, b, c] = [await signIn(server.url), await signIn(server.url), await signIn(server.url)];
    const [aTab, bTab, cTab] = await Promise.all([connect(server, a), connect(server, b), connect(server, c)]);
    const atA = record<PresenceEvent>(aTab, 'presence');
    const atB = record<PresenceEvent>(bTab, 'presence');
    const atC = record<PresenceEvent>(cTab, 'presence');
    const about = (seen: PresenceEvent[], id: string) => seen.filter((e) => e.userId === id);
    await sleep(100);
    expect([...atA, ...atB]).toEqual([]); // no shared conversation yet: nothing

    await as(server.url, a).post('/conversations/direct', { userId: b.id });
    await waitUntil(() => about(atA, b.id).length > 0 && about(atB, a.id).length > 0, 5_000, 'DM introduction');
    expect(about(atA, b.id)[0]).toEqual({ userId: b.id, online: true, lastSeenAt: null });
    expect(about(atB, a.id)[0]).toEqual({ userId: a.id, online: true, lastSeenAt: null });

    // An offline co-member is introduced with their last seen time.
    const gid = (await as(server.url, a).post('/conversations', { title: 'Intro', memberIds: [] })).body.conversation.id as string;
    bTab.disconnect();
    await waitUntil(() => about(atA, b.id).some((e) => !e.online), 3_000, 'B offline');
    await as(server.url, a).post(`/conversations/${gid}/members`, { userId: b.id });
    await as(server.url, a).post(`/conversations/${gid}/members`, { userId: c.id });
    await waitUntil(() => about(atC, a.id).length > 0 && about(atC, b.id).length > 0 && about(atA, c.id).length > 0, 5_000, 'group introduction');
    expect(about(atC, a.id)[0]).toEqual({ userId: a.id, online: true, lastSeenAt: null });
    expect(about(atC, b.id)[0]).toMatchObject({ userId: b.id, online: false, lastSeenAt: expect.any(String) });
    expect(about(atA, c.id)[0]).toEqual({ userId: c.id, online: true, lastSeenAt: null });
    for (const s of [aTab, cTab]) s.disconnect();
  });

  it('sends a snapshot on connect, limited to users who share an active conversation', async () => {
    const [a, b] = await pair();
    const stranger = await signIn(server.url);
    const aTab = await connect(server, a);
    await sleep(50);

    const bSocket = socketFor(server, b);
    const snapshot = await next<{ users: PresenceEvent[] }>(bSocket, 'presence:snapshot');
    expect(snapshot.users).toEqual([{ userId: a.id, online: true, lastSeenAt: null }]);

    const sSocket = socketFor(server, stranger);
    const sSnap = await next<{ users: PresenceEvent[] }>(sSocket, 'presence:snapshot');
    expect(sSnap.users).toEqual([]);
    const strangerSaw = record<PresenceEvent>(sSocket, 'presence');
    aTab.disconnect();
    await sleep(GRACE + 400);
    expect(strangerSaw).toEqual([]); // no shared conversation: no presence at all
    for (const s of [bSocket, sSocket]) s.disconnect();
  });
});
