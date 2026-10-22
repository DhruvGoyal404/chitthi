import { afterAll, describe, expect, inject, it } from 'vitest';
import { createGroup, listConversations } from '../../src/repo/conversations.js';
import { appPool } from '../dbhelpers.js';
import { makeUsers, send } from '../fixtures.js';

// Timing-sensitive (npm run test:perf; its own CI job): 100 sends race for one conversation's
// lock, so a loaded machine can push a waiter past the 5 s statement timeout. The main suite
// keeps a smaller, deterministic version of the same invariant.
const url = inject('apiDbUrl');

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe.skipIf(!url)('concurrency under load (as chitthi_app)', () => {
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
});
