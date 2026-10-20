import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { as, signIn } from './apphelpers.js';
import { adminPool, appPool } from './dbhelpers.js';
import { WEB_ORIGIN } from './helpers.js';
import { connect, connected, disconnected, socketFor, startTestServer, type TestServer } from './sockets.js';

const apiUrl = inject('apiDbUrl');
const ownerUrl = inject('dbUrl');

describe.skipIf(!apiUrl)('socket handshake and session lifetime', () => {
  const pool = appPool(apiUrl);
  const admin = adminPool(ownerUrl);
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(pool, apiUrl);
  });
  afterAll(async () => {
    await server.close();
    await Promise.all([pool.end(), admin.end()]);
  });

  it('accepts a live session cookie from an allowed Origin and joins only the user room', async () => {
    const u = await signIn(server.url);
    const socket = await connect(server, u);
    const sockets = await server.realtime.io.fetchSockets();
    const mine = sockets.find((s) => s.data.userId === u.id);
    expect([...(mine?.rooms ?? [])].filter((r) => r !== mine?.id).sort()).toEqual([`session:${mine?.data.sessionId ?? ''}`, `user:${u.id}`]);
    socket.disconnect();
  });

  it('refuses a missing or unknown session cookie', async () => {
    const u = await signIn(server.url);
    await expect(connected(socketFor(server, null))).rejects.toThrow(/unauthenticated/);
    await expect(connected(socketFor(server, u, { cookie: 'chitthi_session=forged' }))).rejects.toThrow(/unauthenticated/);
  });

  it('refuses a foreign or missing Origin, even with a valid cookie (cross-site WebSocket hijacking)', async () => {
    const u = await signIn(server.url);
    await expect(connected(socketFor(server, u, { origin: 'http://evil.example' }))).rejects.toThrow();
    await expect(connected(socketFor(server, u, { origin: 'http://localhost:5173' }))).rejects.toThrow();
    await expect(connected(socketFor(server, u, { origin: null }))).rejects.toThrow();
  });

  it('disconnects every socket of a session the moment it is revoked, and refuses it afterwards', async () => {
    const u = await signIn(server.url);
    const [tab1, tab2] = await Promise.all([connect(server, u), connect(server, u)]);
    const gone = Promise.all([disconnected(tab1), disconnected(tab2)]);
    expect((await as(server.url, u).post('/dev/logout')).status).toBe(204);
    expect(await gone).toEqual(['io server disconnect', 'io server disconnect']);
    await expect(connected(socketFor(server, u))).rejects.toThrow(/unauthenticated/);
  });

  it('the real sign-out routes disconnect too: logout this session only, logout-all every session', async () => {
    const u = await signIn(server.url);
    const anotherSession = async () => {
      const res = await request(server.url).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: u.handle });
      return { ...u, cookie: (res.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0] ?? '' };
    };
    const v = await anotherSession();
    const w = await anotherSession();
    const [su, sv, sw] = await Promise.all([connect(server, u), connect(server, v), connect(server, w)]);

    const first = disconnected(su);
    expect((await as(server.url, u).post('/auth/logout')).status).toBe(204);
    expect(await first).toBe('io server disconnect');
    expect(sv.connected && sw.connected).toBe(true);

    const rest = Promise.all([disconnected(sv), disconnected(sw)]);
    expect((await as(server.url, v).post('/auth/logout-all')).body).toEqual({ revoked: 2 });
    expect(await rest).toEqual(['io server disconnect', 'io server disconnect']);
  });

  it('disconnects a user who is disabled', async () => {
    const u = await signIn(server.url);
    const socket = await connect(server, u);
    const gone = disconnected(socket);
    await admin.query('UPDATE users SET disabled_at = now() WHERE id = $1', [u.id]);
    expect(await gone).toBe('io server disconnect');
  });

  it('disconnects when the session expires', async () => {
    const u = await signIn(server.url);
    await admin.query(
      `UPDATE sessions SET created_at = now() - interval '1 day', expires_at = now() + interval '1500 milliseconds'
        WHERE user_id = $1`,
      [u.id],
    );
    const socket = await connect(server, u);
    const started = Date.now();
    expect(await disconnected(socket, 5_000)).toBe('io server disconnect');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('accepts no message writes over the socket: an unknown event disconnects', async () => {
    const u = await signIn(server.url);
    const socket = await connect(server, u);
    const gone = disconnected(socket);
    socket.emit('message:send', { conversationId: '00000000-0000-0000-0000-000000000000', body: 'nope' });
    expect(await gone).toBe('io server disconnect');
  });

  it('limits connections per user', async () => {
    const strict = await startTestServer(pool, apiUrl, {
      limits: { auth: { points: 100, duration: 60 }, send: { points: 100, duration: 60 }, socket: { points: 2, duration: 60 }, search: { points: 2, duration: 60 } },
    });
    try {
      const u = await signIn(strict.url);
      const a = await connect(strict, u);
      const b = await connect(strict, u);
      await expect(connected(socketFor(strict, u))).rejects.toThrow(/rate_limited/);
      a.disconnect();
      b.disconnect();
    } finally {
      await strict.close();
    }
  });
});
