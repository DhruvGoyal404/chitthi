import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { addMember, createGroup, findOrCreateDirect, listConversations, removeMember, unreadCount } from '../src/repo/conversations.js';
import {
  catchUpByChange, catchUpBySeq, deleteForEveryone, editMessage, history, markDelivered, markRead, sendMessage, type Message,
} from '../src/repo/messages.js';
import { appPool } from './dbhelpers.js';
import { makeUsers, rejectsWith, send } from './fixtures.js';

// Integrity properties of the data model, exercised the way the API runs: every query as
// chitthi_app, concurrency through a real pool (25 connections) against Postgres 18.
const url = inject('apiDbUrl');

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe.skipIf(!url)('data model integrity (as chitthi_app)', () => {
  const pool = appPool(url, 25);
  afterAll(async () => {
    await pool.end();
  });

  async function counters(conversationId: string) {
    const { rows: [c] } = await pool.query<{ last_seq: number; change_seq: number }>(
      'SELECT last_seq, change_seq FROM conversations WHERE id = $1', [conversationId],
    );
    const { rows } = await pool.query<{ seq: number; change: number }>(
      'SELECT seq, updated_change_seq AS change FROM messages WHERE conversation_id = $1 ORDER BY seq', [conversationId],
    );
    return { lastSeq: c?.last_seq, changeSeq: c?.change_seq, seqs: rows.map((r) => r.seq), changes: rows.map((r) => r.change) };
  }

  it('assigns gap-free, unique seqs to 20 concurrent senders (100 messages)', async () => {
    const users = await makeUsers(pool, 20, 'snd');
    const [owner, ...rest] = users;
    if (!owner) throw new Error('fixture');
    const g = await createGroup(pool, { creatorId: owner.id, title: 'Stampede', memberIds: rest.map((u) => u.id) }); // seq 1

    const results = await Promise.all(users.flatMap((u) => range(1, 5).map((i) => send(pool, g.id, u.id, `${u.handle} #${String(i)}`))));

    expect(results.map((m) => m.seq).sort((a, b) => a - b)).toEqual(range(2, 101));
    const c = await counters(g.id);
    expect(c.seqs).toEqual(range(1, 101));
    expect(c.lastSeq).toBe(101);
    // No edits yet: every message's change value equals its seq, and the cursor equals last_seq.
    expect(c.changes).toEqual(range(1, 101));
    expect(c.changeSeq).toBe(101);
    // Each sender's own messages are in their send order, and their read marker covers their last one.
    for (const u of users) {
      const mine = results.filter((m) => m.senderId === u.id);
      expect(mine.map((m) => m.body)).toEqual(range(1, 5).map((i) => `${u.handle} #${String(i)}`));
      const inbox = await listConversations(pool, u.id);
      expect(inbox[0]?.lastReadSeq).toBeGreaterThanOrEqual(Math.max(...mine.map((m) => m.seq)));
    }
  });

  it('turns concurrent retries of one send into exactly one message, without a seq gap', async () => {
    const [a, b] = await makeUsers(pool, 2, 'idem');
    if (!a || !b) throw new Error('fixture');
    const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
    const clientMsgId = randomUUID();

    // 15 retries of the same send race 15 unrelated sends from the other participant.
    const retries = range(1, 15).map(() => sendMessage(pool, { conversationId: c.id, senderId: a.id, clientMsgId, body: 'only once' }));
    const others = range(1, 15).map((i) => send(pool, c.id, b.id, `b ${String(i)}`));
    const [retried] = await Promise.all([Promise.all(retries), Promise.all(others)]);

    const ids = new Set(retried.map((r) => r.message.id));
    expect(ids.size).toBe(1);
    expect(retried.filter((r) => !r.duplicate)).toHaveLength(1);
    const { rows } = await pool.query('SELECT 1 FROM messages WHERE sender_id = $1 AND client_msg_id = $2', [a.id, clientMsgId]);
    expect(rows).toHaveLength(1);
    // 1 + 15 messages, seq 1..16 with no holes even though 14 inserts rolled back.
    const k = await counters(c.id);
    expect(k.seqs).toEqual(range(1, 16));
    expect(k.lastSeq).toBe(16);
    expect(k.changeSeq).toBe(16);

    // A later retry still returns the original; the same id with another body is refused.
    const late = await sendMessage(pool, { conversationId: c.id, senderId: a.id, clientMsgId, body: 'only once' });
    expect(late).toMatchObject({ duplicate: true, message: { id: [...ids][0] } });
    await rejectsWith(sendMessage(pool, { conversationId: c.id, senderId: a.id, clientMsgId, body: 'something else' }), 409, 'idempotency_conflict');
  });

  it('lets one of many concurrent sends with the same id and different bodies win, and rejects the rest', async () => {
    const [a, b] = await makeUsers(pool, 2, 'race');
    if (!a || !b) throw new Error('fixture');
    const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
    const clientMsgId = randomUUID();
    const outcomes = await Promise.allSettled(
      range(1, 10).map((i) => sendMessage(pool, { conversationId: c.id, senderId: a.id, clientMsgId, body: `variant ${String(i)}` })),
    );
    const won = outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []));
    const lost = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason as { code?: string }] : []));
    expect(won).toHaveLength(1);
    expect(won[0]?.duplicate).toBe(false);
    expect(lost.map((e) => e.code)).toEqual(Array<string>(9).fill('idempotency_conflict'));
    expect((await counters(c.id)).seqs).toEqual([1]);
  });

  it('never lets a removed member post after left_seq, even with sends in flight', async () => {
    const [owner, c] = await makeUsers(pool, 2, 'evict');
    if (!owner || !c) throw new Error('fixture');
    const g = await createGroup(pool, { creatorId: owner.id, title: 'Eviction', memberIds: [c.id] });
    const sends = range(1, 30).map((i) => send(pool, g.id, c.id, `c ${String(i)}`));
    const removal = removeMember(pool, { conversationId: g.id, actorId: owner.id, userId: c.id });
    const [settled, { leftSeq }] = await Promise.all([Promise.allSettled(sends), removal]);

    const posted = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    const refused = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as { code?: string }] : []));
    expect(posted.length + refused.length).toBe(30);
    for (const m of posted) expect(m.seq).toBeLessThan(leftSeq); // left_seq itself is the member_removed notice
    for (const e of refused) expect(e.code).toBe('read_only');
    const k = await counters(g.id);
    expect(k.seqs).toEqual(range(1, k.lastSeq ?? 0)); // still gap-free
  });

  describe('visibility windows', () => {
    // Timeline (seq): 1 created · 2-3 before C · 4 C added · 5 C writes · 6 O writes · 7 C removed ·
    // 8-9 while C is away · 10 C re-added · 11 O writes. C's windows: [4,7] and [10,∞).
    async function scenario() {
      const [o, b, c] = await makeUsers(pool, 3, 'win');
      if (!o || !b || !c) throw new Error('fixture');
      const g = await createGroup(pool, { creatorId: o.id, title: 'Windows', memberIds: [b.id] });
      const m2 = await send(pool, g.id, o.id, 'before C, 2');
      await send(pool, g.id, b.id, 'before C, 3');
      await addMember(pool, { conversationId: g.id, actorId: o.id, userId: c.id });
      const m5 = await send(pool, g.id, c.id, 'C was here');
      const m6 = await send(pool, g.id, o.id, 'welcome C');
      await removeMember(pool, { conversationId: g.id, actorId: o.id, userId: c.id });
      const m8 = await send(pool, g.id, o.id, 'C is gone, 8');
      await send(pool, g.id, b.id, 'C is gone, 9');
      return { o, b, c, g, m2, m5, m6, m8 };
    }

    it('limits history and seq catch-up to the windows, across a removal and a rejoin', async () => {
      const { o, c, g } = await scenario();
      const whileAway = await history(pool, { conversationId: g.id, userId: c.id });
      expect(whileAway.messages.map((m) => m.seq)).toEqual([4, 5, 6, 7]);
      expect(whileAway.messages.map((m) => m.meta?.event ?? m.body)).toEqual(['member_added', 'C was here', 'welcome C', 'member_removed']);
      expect((await catchUpBySeq(pool, { conversationId: g.id, userId: c.id, afterSeq: 5 })).messages.map((m) => m.seq)).toEqual([6, 7]);

      await addMember(pool, { conversationId: g.id, actorId: o.id, userId: c.id }); // seq 10
      await send(pool, g.id, o.id, 'welcome back');                                   // seq 11
      const all = await history(pool, { conversationId: g.id, userId: c.id });
      expect(all.messages.map((m) => m.seq)).toEqual([4, 5, 6, 7, 10, 11]);
      const paged = await history(pool, { conversationId: g.id, userId: c.id, beforeSeq: 10, limit: 2 });
      expect(paged.messages.map((m) => m.seq)).toEqual([6, 7]);
      expect((await catchUpBySeq(pool, { conversationId: g.id, userId: c.id, afterSeq: 0 })).messages.map((m) => m.seq)).toEqual([4, 5, 6, 7, 10, 11]);
      // The rejoin starts C's marker at 9: only O's "welcome back" (11) is unread; 10 is a system message.
      expect(await unreadCount(pool, g.id, c.id)).toBe(1);
    });

    it('limits change-cursor catch-up to the windows: edits and deletes outside are invisible', async () => {
      const { o, b, c, g, m2, m5, m6, m8 } = await scenario();
      const before = await catchUpByChange(pool, { conversationId: g.id, userId: c.id, afterChange: 0 });
      expect(before.messages.map((m) => m.seq)).toEqual([4, 5, 6, 7]);
      const cursor = before.nextCursor;
      expect(cursor).toBe(9); // the conversation's change_seq, although C saw nothing past 7

      await editMessage(pool, { messageId: m2.id, userId: o.id, body: 'edited before C' });   // outside: invisible
      await editMessage(pool, { messageId: m6.id, userId: o.id, body: 'welcome C (edited)' }); // inside: visible
      await deleteForEveryone(pool, { messageId: m8.id, userId: o.id });                      // outside: invisible
      await deleteForEveryone(pool, { messageId: m5.id, userId: c.id });                      // C erases own words after removal

      const after = await catchUpByChange(pool, { conversationId: g.id, userId: c.id, afterChange: cursor });
      expect(after.messages.map((m) => [m.seq, m.body])).toEqual([[6, 'welcome C (edited)'], [5, null]]);
      expect(after.nextCursor).toBe(13);
      // B, a member throughout, sees every change.
      const bAfter = await catchUpByChange(pool, { conversationId: g.id, userId: b.id, afterChange: cursor });
      expect(bAfter.messages.map((m) => m.seq)).toEqual([2, 6, 8, 5]);
      // Paging by cursor visits each change once, in order.
      const seen: Message[] = [];
      let cur = 0;
      for (;;) {
        const page = await catchUpByChange(pool, { conversationId: g.id, userId: b.id, afterChange: cur, limit: 3 });
        seen.push(...page.messages);
        cur = page.nextCursor;
        if (!page.hasMore) break;
      }
      expect(seen.map((m) => m.changeSeq)).toEqual([...seen.map((m) => m.changeSeq)].sort((x, y) => x - y));
      expect(new Set(seen.map((m) => m.id)).size).toBe(seen.length);
      expect(cur).toBe(13);
    });

    it('keeps a former member read-only: no send, no edit, markers capped at left_seq', async () => {
      const { c, g, m5 } = await scenario();
      await rejectsWith(send(pool, g.id, c.id), 403, 'read_only');
      await rejectsWith(editMessage(pool, { messageId: m5.id, userId: c.id, body: 'too late' }), 403, 'read_only');
      expect(await markRead(pool, { conversationId: g.id, userId: c.id, seq: 999 })).toEqual({ lastReadSeq: 7, lastDeliveredSeq: 7 });
      // Even a raw insert, bypassing the repository, is refused by the trigger.
      await expect(pool.query(
        `INSERT INTO messages (conversation_id, sender_id, client_msg_id, send_body_sha256, kind, body)
         VALUES ($1, $2, gen_random_uuid(), sha256('x'), 'text', 'x')`, [g.id, c.id],
      )).rejects.toThrow(/not an active member/);
    });
  });

  it('gives non-members nothing, through the repository or a raw insert', async () => {
    const [a, b, stranger] = await makeUsers(pool, 3, 'nm');
    if (!a || !b || !stranger) throw new Error('fixture');
    const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
    const m = await send(pool, c.id, a.id, 'private');
    const s = { conversationId: c.id, userId: stranger.id };
    await rejectsWith(history(pool, s), 404, 'not_found');
    await rejectsWith(catchUpBySeq(pool, { ...s, afterSeq: 0 }), 404, 'not_found');
    await rejectsWith(catchUpByChange(pool, { ...s, afterChange: 0 }), 404, 'not_found');
    await rejectsWith(markRead(pool, { ...s, seq: 1 }), 404, 'not_found');
    await rejectsWith(markDelivered(pool, { ...s, seq: 1 }), 404, 'not_found');
    await rejectsWith(send(pool, c.id, stranger.id), 404, 'not_found');
    await rejectsWith(editMessage(pool, { messageId: m.id, userId: stranger.id, body: 'x' }), 404, 'not_found');
    await rejectsWith(deleteForEveryone(pool, { messageId: m.id, userId: stranger.id }), 404, 'not_found');
    await rejectsWith(unreadCount(pool, c.id, stranger.id), 404, 'not_found');
    expect(await listConversations(pool, stranger.id)).toEqual([]);
    await expect(pool.query(
      `INSERT INTO messages (conversation_id, sender_id, client_msg_id, send_body_sha256, kind, body)
       VALUES ($1, $2, gen_random_uuid(), sha256('x'), 'text', 'x')`, [c.id, stranger.id],
    )).rejects.toThrow(/not an active member/);
    // A stranger can't join a DM either, even with a raw insert.
    await expect(pool.query('INSERT INTO conversation_memberships (conversation_id, user_id) VALUES ($1, $2)', [c.id, stranger.id]))
      .rejects.toThrow(/only the two participants/);
  });

  it('never moves a read marker backwards, under concurrency or by a raw update', async () => {
    const [a, b] = await makeUsers(pool, 2, 'mark');
    if (!a || !b) throw new Error('fixture');
    const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
    for (let i = 0; i < 20; i++) await send(pool, c.id, a.id);

    const seqs = range(1, 20).sort(() => Math.random() - 0.5);
    await Promise.all(seqs.map((seq) => (seq % 2 ? markRead : markDelivered)(pool, { conversationId: c.id, userId: b.id, seq })));
    const final = await markRead(pool, { conversationId: c.id, userId: b.id, seq: 0 });
    expect(final).toEqual({ lastReadSeq: 19, lastDeliveredSeq: 20 }); // max odd seq read, max seq delivered

    expect(await markRead(pool, { conversationId: c.id, userId: b.id, seq: 3 })).toEqual(final);
    expect((await markRead(pool, { conversationId: c.id, userId: b.id, seq: 10_000 })).lastReadSeq).toBe(20); // clamped
    await expect(pool.query('UPDATE read_markers SET last_read_seq = 1 WHERE conversation_id = $1 AND user_id = $2', [c.id, b.id]))
      .rejects.toThrow(/only move forward/);
    await expect(pool.query('UPDATE read_markers SET last_delivered_seq = 99, last_read_seq = 99 WHERE conversation_id = $1 AND user_id = $2', [c.id, b.id]))
      .rejects.toThrow(/beyond the visible range/);
  });

  it('keeps tombstones without a body, a hash or any way back', async () => {
    const [a, b] = await makeUsers(pool, 2, 'tomb');
    if (!a || !b) throw new Error('fixture');
    const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
    const clientMsgId = randomUUID();
    const { message } = await sendMessage(pool, { conversationId: c.id, senderId: a.id, clientMsgId, body: 'regret' });
    await editMessage(pool, { messageId: message.id, userId: a.id, body: 'regret (edited)' });
    const tomb = await deleteForEveryone(pool, { messageId: message.id, userId: a.id });
    expect(tomb).toMatchObject({ seq: message.seq, body: null });

    const { rows: [row] } = await pool.query<{ body: string | null; hash: Buffer | null; seq: number }>(
      'SELECT body, send_body_sha256 AS hash, seq FROM messages WHERE id = $1', [message.id],
    );
    expect(row).toEqual({ body: null, hash: null, seq: message.seq });
    // Retrying the original send returns the tombstone rather than re-sending the erased text.
    const retry = await sendMessage(pool, { conversationId: c.id, senderId: a.id, clientMsgId, body: 'regret' });
    expect(retry).toMatchObject({ duplicate: true, message: { id: message.id, body: null } });
    expect((await counters(c.id)).seqs).toEqual([1]);

    // Raw writes as chitthi_app can't resurrect content or remove the row.
    await expect(pool.query("UPDATE messages SET body = 'back' WHERE id = $1", [message.id])).rejects.toThrow(/deleted message cannot change/);
    await expect(pool.query('DELETE FROM messages WHERE id = $1', [message.id])).rejects.toThrow(/permission denied/);
    // Deleting with a body in the same statement still erases it.
    const other = await send(pool, c.id, a.id, 'second regret');
    const { rows: [erased] } = await pool.query<{ body: string | null }>(
      "UPDATE messages SET deleted_at = now(), body = 'sneaky' WHERE id = $1 RETURNING body", [other.id],
    );
    expect(erased?.body).toBeNull();
  });

  it('creates exactly one direct conversation per pair under concurrent creation', async () => {
    const [a, b] = await makeUsers(pool, 2, 'dm');
    if (!a || !b) throw new Error('fixture');
    const results = await Promise.all(range(1, 20).map((i) => (i % 2 ? findOrCreateDirect(pool, a.id, b.id) : findOrCreateDirect(pool, b.id, a.id))));
    expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const id = results[0]?.conversation.id;
    const { rows: [n] } = await pool.query<{ pairs: number; members: number; convs: number }>(
      `SELECT (SELECT count(*)::int FROM direct_conversations WHERE $2::uuid IN (user_lo, user_hi) AND $3::uuid IN (user_lo, user_hi)) AS pairs,
              (SELECT count(*)::int FROM conversation_memberships WHERE conversation_id = $1) AS members,
              (SELECT count(*)::int FROM conversations WHERE kind = 'direct' AND created_by IN ($2, $3)) AS convs`,
      [id, a.id, b.id],
    );
    // No orphaned conversation rows from the losing transactions: they rolled back entirely.
    expect(n).toEqual({ pairs: 1, members: 2, convs: 1 });
  });
});
