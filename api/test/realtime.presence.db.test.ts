import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { PresenceEvent } from '../src/realtime/presence.js';
import { as, signIn, type Signed } from './apphelpers.js';
import { adminPool, appPool } from './dbhelpers.js';
import { connect, next, record, sleep, socketFor, startTestServer, type TestServer } from './sockets.js';

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
