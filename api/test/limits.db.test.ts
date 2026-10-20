import { randomBytes, randomUUID } from 'node:crypto';
import type request from 'supertest';
import { afterAll, describe, expect, inject, it } from 'vitest';
import type { Limits } from '../src/limits.js';
import { as, GENEROUS, signIn, testApp } from './apphelpers.js';
import { appPool } from './dbhelpers.js';

const apiUrl = inject('apiDbUrl');

/** A 429 that says which limit, how long to wait, and something a person can read. */
function expectLimited(res: request.Response, limit: keyof Limits) {
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe('rate_limited');
  expect(res.body.error.details.limit).toBe(limit);
  expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  expect(res.body.error.message).not.toMatch(/limit|429/i);
}

describe.skipIf(!apiUrl)('rate limits (Postgres store)', () => {
  const pool = appPool(apiUrl);
  afterAll(async () => {
    await pool.end();
  });
  const appWith = (overrides: Partial<Limits>) => testApp(pool, apiUrl, { ...GENEROUS, ...overrides });

  async function dmIn(app: ReturnType<typeof testApp>) {
    const a = await signIn(app, 'lm');
    const b = await signIn(app, 'lm');
    const id = (await as(app, a).post('/conversations/direct', { userId: b.id })).body.conversation.id as string;
    const send = (body = 'x') => as(app, a).post(`/conversations/${id}/messages`, { clientMsgId: randomUUID(), body });
    return { a, b, id, send };
  }

  it('sends: a short burst window, and edits and deletes count too', async () => {
    const app = appWith({ sendBurst: { points: 3, duration: 60 } });
    const { a, id, send } = await dmIn(app);
    const first = await send();
    expect(first.status).toBe(201);
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const limited = await send();
    expectLimited(limited, 'sendBurst');
    expect(limited.body.error.message).toBe("You're sending quickly. Wait a moment, then retry.");
    expectLimited(await as(app, a).patch(`/conversations/${id}/messages/${first.body.message.id as string}`, { body: 'y' }), 'sendBurst');
  });

  it('sends: a sustained window behind the burst', async () => {
    const { send } = await dmIn(appWith({ send: { points: 2, duration: 600 } }));
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    expectLimited(await send(), 'send');
  });

  it('the default limits are generous enough for a lively chat', async () => {
    const { DEFAULT_LIMITS } = await import('../src/limits.js');
    const { send } = await dmIn(appWith({ sendBurst: DEFAULT_LIMITS.sendBurst, send: DEFAULT_LIMITS.send }));
    // Twenty messages as fast as the API takes them: a person typing quickly never gets near this.
    for (let i = 0; i < 20; i++) expect((await send(`line ${String(i)}`)).status).toBe(201);
  });

  it('new DMs per day: only creating one counts; reopening is always allowed', async () => {
    const app = appWith({ newDm: { points: 2, duration: 86_400 } });
    const me = await signIn(app, 'nd');
    const [b, c, d] = await Promise.all([signIn(app, 'nd'), signIn(app, 'nd'), signIn(app, 'nd')]);
    const open = (u: { id: string }) => as(app, me).post('/conversations/direct', { userId: u.id });
    expect((await open(b)).status).toBe(201);
    expect((await open(b)).status).toBe(200);
    expect((await open(c)).status).toBe(201);
    expectLimited(await open(d), 'newDm');
    expect((await open(b)).status).toBe(200); // still fine at the limit
    // The other person can still start one with me (their own allowance).
    expect((await as(app, d).post('/conversations/direct', { userId: me.id })).status).toBe(201);
  });

  it('group creation and member adds per user (initial members count)', async () => {
    const app = appWith({ groupCreate: { points: 1, duration: 86_400 }, memberAdd: { points: 3, duration: 86_400 } });
    const owner = await signIn(app, 'gl');
    const [b, c, d, e] = await Promise.all([signIn(app, 'gl'), signIn(app, 'gl'), signIn(app, 'gl'), signIn(app, 'gl')]);
    const group = await as(app, owner).post('/conversations', { title: 'Mess committee', memberIds: [b.id, c.id] });
    expect(group.status).toBe(201);
    const gid = group.body.conversation.id as string;
    expect((await as(app, owner).post(`/conversations/${gid}/members`, { userId: d.id })).status).toBe(201);
    expectLimited(await as(app, owner).post(`/conversations/${gid}/members`, { userId: e.id }), 'memberAdd');
    expectLimited(await as(app, owner).post('/conversations', { title: 'Second', memberIds: [] }), 'groupCreate');
  });

  it('handle search: at least 3 characters, at most 8 results, and a per-user budget shared with exact lookups', async () => {
    const app = appWith({ search: { points: 3, duration: 60 } });
    const tag = `s${randomBytes(3).toString('hex')}`;
    await Promise.all(Array.from({ length: 10 }, () => signIn(app, tag)));
    const me = await signIn(app, 'srch');
    expect((await as(app, me).get('/users?q=ab')).status).toBe(400); // too short (and it still counts: the limit runs first)
    const found = await as(app, me).get(`/users?q=${tag}`);
    expect(found.status).toBe(200);
    expect(found.body.users).toHaveLength(8);
    expect((await as(app, me).get(`/users/${me.handle}`)).status).toBe(200);
    expectLimited(await as(app, me).get(`/users?q=${tag}`), 'search');
    expectLimited(await as(app, me).get(`/users/${me.handle}`), 'search');
  });
});
