import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { as, signIn, testApp, type Signed, type Target } from './apphelpers.js';
import { adminPool, appPool } from './dbhelpers.js';
import { WEB_ORIGIN } from './helpers.js';
import { connect, disconnected, startTestServer, type TestServer } from './sockets.js';

const apiUrl = inject('apiDbUrl');
const ownerUrl = inject('dbUrl');

const say = (app: Target, u: Signed, conversationId: string, body: string) =>
  as(app, u).post(`/conversations/${conversationId}/messages`, { clientMsgId: randomUUID(), body });

describe.skipIf(!apiUrl)('account deletion', () => {
  const pool = appPool(apiUrl);
  const admin = adminPool(ownerUrl);
  const app = testApp(pool, apiUrl);
  afterAll(async () => {
    await Promise.all([pool.end(), admin.end()]);
  });

  /** Every conversation's seqs are exactly 1..last_seq (no gaps, no duplicates). */
  async function expectGapFree(conversationIds: string[]) {
    const { rows } = await admin.query<{ id: string; n: number; max: number; last: number }>(
      `SELECT c.id, count(m.id)::int AS n, COALESCE(max(m.seq), 0)::int AS max, c.last_seq::int AS last
         FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.id = ANY($1::uuid[]) GROUP BY c.id`,
      [conversationIds],
    );
    for (const r of rows) expect({ n: r.n, max: r.max }).toEqual({ n: r.last, max: r.last });
  }

  /** The inbox's unread equals the definition, recomputed here from the rows. */
  async function expectUnreadConsistent(u: Signed) {
    const inbox = (await as(app, u).get('/conversations')).body.conversations as { id: string; unread: number }[];
    for (const c of inbox) {
      const { rows: [r] } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM messages m
           JOIN read_markers rm ON rm.conversation_id = m.conversation_id AND rm.user_id = $2
           JOIN LATERAL (SELECT * FROM conversation_memberships p WHERE p.conversation_id = m.conversation_id AND p.user_id = $2
                          ORDER BY joined_seq DESC LIMIT 1) p ON true
          WHERE m.conversation_id = $1 AND m.kind = 'text' AND m.deleted_at IS NULL AND m.sender_id <> $2
            AND m.seq > rm.last_read_seq AND m.seq >= p.joined_seq AND (p.left_seq IS NULL OR m.seq <= p.left_seq)`,
        [c.id, u.id],
      );
      expect(c.unread, `unread in ${c.id}`).toBe(r?.n);
    }
  }

  /** a with a DM to b, a group a owns with b and admin c, and a group b owns with a in it. */
  async function world() {
    const [a, b, c] = [await signIn(app, 'del'), await signIn(app, 'del'), await signIn(app, 'del')];
    const dm = (await as(app, a).post('/conversations/direct', { userId: b.id })).body.conversation.id as string;
    const owned = (await as(app, a).post('/conversations', { title: 'Owned by a', memberIds: [b.id] })).body.conversation.id as string;
    await as(app, a).post(`/conversations/${owned}/members`, { userId: c.id, role: 'admin' });
    const other = (await as(app, b).post('/conversations', { title: 'Owned by b', memberIds: [a.id] })).body.conversation.id as string;
    for (const [conv, text] of [[dm, 'dm from a'], [owned, 'owned from a'], [other, 'other from a']] as const) await say(app, a, conv, text);
    await say(app, b, dm, 'dm from b');
    await say(app, b, owned, 'owned from b');
    await as(app, b).post(`/conversations/${owned}/read`, { seq: 1 }); // leave b some unread
    return { a, b, c, dm, owned, other };
  }

  const del = (u: Signed, body: object) => as(app, u).delete('/me').send(body);

  it('asks for the handle again, and refuses anything else', async () => {
    const a = await signIn(app, 'cnf');
    expect((await del(a, {})).status).toBe(400);
    expect((await del(a, { confirmHandle: 'someone_else' })).body.error.code).toBe('confirmation_mismatch');
    expect((await request(app).delete('/api/me').set('Cookie', a.cookie).send({ confirmHandle: a.handle })).status).toBe(403); // Origin
    expect((await request(app).delete('/api/me').set('Origin', WEB_ORIGIN).send({ confirmHandle: a.handle })).status).toBe(401);
    expect((await as(app, a).get('/me')).status).toBe(200); // still there
  });

  it('default: messages stay for others as "Deleted user"; groups are left, ownership passes on; everything else is removed', async () => {
    const { a, b, c, dm, owned, other } = await world();
    const before = (await as(app, b).get('/conversations')).body.conversations as { id: string; unread: number; lastSeq: number }[];
    await as(app, a).put(`/blocks/${c.id}`);

    const res = await del(a, { confirmHandle: a.handle.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, groupsLeft: 2, ownershipTransferred: 1, messagesErased: 0 });
    expect(String(res.headers['set-cookie'])).toMatch(/chitthi_session=;/);
    expect((await as(app, a).get('/me')).status).toBe(401);

    // Identities, sessions, blocks: gone. The row stays, emptied.
    const { rows: [left] } = await admin.query<Record<string, unknown>>(
      `SELECT u.handle, u.display_name, u.avatar_url, u.disabled_at IS NOT NULL AS disabled, u.deleted_at IS NOT NULL AS deleted,
              (SELECT count(*)::int FROM identities WHERE user_id = u.id) AS identities,
              (SELECT count(*)::int FROM sessions WHERE user_id = u.id) AS sessions,
              (SELECT count(*)::int FROM user_blocks WHERE blocker_id = u.id OR blocked_id = u.id) AS blocks
         FROM users u WHERE u.id = $1`,
      [a.id],
    );
    expect(left).toMatchObject({ display_name: 'Deleted user', avatar_url: null, disabled: true, deleted: true, identities: 0, sessions: 0, blocks: 0 });
    expect(left?.handle).toMatch(/^del_[0-9a-f]{16}$/);

    // b's DM: history intact, author shown as Deleted user, no new messages, nothing advanced.
    const dmView = (await as(app, b).get(`/conversations/${dm}`)).body.conversation;
    expect(dmView.members.find((m: { userId: string }) => m.userId === a.id)).toMatchObject({ displayName: 'Deleted user', deleted: true, active: true });
    const history = (await as(app, b).get(`/conversations/${dm}/messages`)).body.messages as { senderId: string; body: string | null }[];
    expect(history.find((m) => m.senderId === a.id)?.body).toBe('dm from a');
    const refused = await say(app, b, dm, 'hello?');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('recipient_deleted');
    expect((await as(app, b).post('/conversations/direct', { userId: a.id })).status).toBe(200); // still opens
    const inbox = (await as(app, b).get('/conversations')).body.conversations as { id: string; unread: number; lastSeq: number; peer: { deleted: boolean; displayName: string } | null }[];
    expect(inbox.find((x) => x.id === dm)?.peer).toMatchObject({ deleted: true, displayName: 'Deleted user' });
    expect(inbox.find((x) => x.id === dm)).toMatchObject({ lastSeq: before.find((x) => x.id === dm)?.lastSeq, unread: before.find((x) => x.id === dm)?.unread });

    // The group a owned: the admin c is the owner now; a left with reason 'deleted', after two notices.
    const ownedView = (await as(app, c).get(`/conversations/${owned}`)).body.conversation;
    expect(ownedView.members.find((m: { userId: string }) => m.userId === c.id).role).toBe('owner');
    expect(ownedView.members.find((m: { userId: string }) => m.userId === a.id)).toMatchObject({ active: false, deleted: true });
    const tail = (await as(app, c).get(`/conversations/${owned}/messages`)).body.messages.slice(-2).map((m: { meta: unknown }) => m.meta);
    expect(tail).toEqual([{ event: 'owner_changed', actor: a.id, target: c.id }, { event: 'member_left', actor: a.id }]);
    const { rows: [period] } = await admin.query<{ left_reason: string; left_seq: number; last_seq: number }>(
      `SELECT p.left_reason, p.left_seq, c.last_seq FROM conversation_memberships p JOIN conversations c ON c.id = p.conversation_id
        WHERE p.conversation_id = $1 AND p.user_id = $2`,
      [owned, a.id],
    );
    expect(period).toMatchObject({ left_reason: 'deleted' });
    expect(period?.left_seq).toBe(period?.last_seq); // the window ends at the member_left notice
    expect((await as(app, b).get(`/conversations/${other}`)).body.conversation.members.find((m: { userId: string }) => m.userId === b.id).role).toBe('owner');

    // Invariants: gap-free seqs, unread exactly as defined, for everyone who remains.
    await expectGapFree([dm, owned, other]);
    await expectUnreadConsistent(b);
    await expectUnreadConsistent(c);
    // A deleted account can't be found or messaged anew.
    expect((await as(app, c).post('/conversations/direct', { userId: a.id })).status).toBe(404);
  });

  it('opt-in: every message the user sent becomes a tombstone (seqs kept, unread follows)', async () => {
    const { a, b, c, dm, owned, other } = await world();
    const res = await del(a, { confirmHandle: a.handle, eraseMessages: true });
    expect(res.body).toMatchObject({ deleted: true, messagesErased: 3 });
    for (const conv of [dm, owned]) {
      const msgs = (await as(app, b).get(`/conversations/${conv}/messages`)).body.messages as { senderId: string | null; body: string | null; deletedAt: string | null; kind: string }[];
      const mine = msgs.filter((m) => m.senderId === a.id && m.kind === 'text');
      expect(mine.length).toBeGreaterThan(0);
      for (const m of mine) expect(m).toMatchObject({ body: null, deletedAt: expect.any(String) });
      expect(msgs.filter((m) => m.senderId === b.id).every((m) => m.body !== null)).toBe(true); // others' untouched
    }
    const { rows: [hashes] } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM messages WHERE sender_id = $1 AND (body IS NOT NULL OR send_body_sha256 IS NOT NULL)", [a.id],
    );
    expect(hashes?.n).toBe(0);
    await expectGapFree([dm, owned, other]);
    await expectUnreadConsistent(b);
    await expectUnreadConsistent(c);
  });

  it('holds the handle for 30 days: nobody else can take it, then it is free', async () => {
    const a = await signIn(app, 'hld');
    await del(a, { confirmHandle: a.handle });
    const taker = await signIn(app, 'tkr');
    const take = await as(app, taker).patch('/me', { handle: a.handle.toUpperCase() });
    expect(take.status).toBe(409);
    expect(take.body.error.code).toBe('handle_taken'); // doesn't say whose, or that it was deleted
    expect((await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: a.handle })).status).toBe(409);
    const { rows: [hold] } = await admin.query<{ days: number }>(
      "SELECT round(extract(epoch FROM held_until - now()) / 86400)::int AS days FROM handle_holds WHERE handle = lower($1)", [a.handle],
    );
    expect(hold?.days).toBe(30);
    await admin.query("UPDATE handle_holds SET held_until = now() - interval '1 second' WHERE handle = lower($1)", [a.handle]);
    expect((await as(app, taker).patch('/me', { handle: a.handle })).status).toBe(200);
  });

  it('a second request for the same account finds nothing to delete', async () => {
    const a = await signIn(app, 'twc');
    const [first, second] = await Promise.all([del(a, { confirmHandle: a.handle }), del(a, { confirmHandle: a.handle })]);
    // Exactly one succeeds; the other finds the session gone (401) or the account already deleted (404).
    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(200);
    expect([401, 404]).toContain(statuses[1]);
  });
});

describe.skipIf(!apiUrl)('account deletion: sockets', () => {
  const pool = appPool(apiUrl);
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(pool, apiUrl);
  });
  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it("disconnects every socket of the deleted account, and the other side's sockets stay", async () => {
    const [a, b] = [await signIn(server.url), await signIn(server.url)];
    await as(server.url, a).post('/conversations/direct', { userId: b.id });
    const [t1, t2, bTab] = await Promise.all([connect(server, a), connect(server, a), connect(server, b)]);
    const gone = Promise.all([disconnected(t1), disconnected(t2)]);
    expect((await as(server.url, a).delete('/me').send({ confirmHandle: a.handle })).status).toBe(200);
    expect(await gone).toEqual(['io server disconnect', 'io server disconnect']);
    expect(bTab.connected).toBe(true);
    bTab.disconnect();
  });
});
