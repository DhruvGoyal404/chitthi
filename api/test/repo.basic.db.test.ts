import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, inject, it } from 'vitest';
import {
  addMember, createGroup, findOrCreateDirect, leave, listConversations, removeMember, unreadCount,
} from '../src/repo/conversations.js';
import {
  catchUpByChange, catchUpBySeq, deleteForEveryone, editMessage, history, markDelivered, markRead, sendMessage,
} from '../src/repo/messages.js';
import { appPool } from './dbhelpers.js';
import { makeUsers, rejectsWith, send } from './fixtures.js';

const url = inject('dbUrl');

describe.skipIf(!url)('repository layer (as chitthi_app)', () => {
  const pool = appPool(url);
  afterAll(async () => {
    await pool.end();
  });

  describe('direct conversations', () => {
    it('finds or creates exactly one conversation per pair, in either order', async () => {
      const [a, b] = await makeUsers(pool, 2);
      if (!a || !b) throw new Error('fixture');
      const first = await findOrCreateDirect(pool, a.id, b.id);
      const second = await findOrCreateDirect(pool, b.id, a.id);
      expect(first.created).toBe(true);
      expect(second).toEqual({ conversation: first.conversation, created: false });
      expect(first.conversation.kind).toBe('direct');
      expect(first.conversation.title).toBeNull();
    });

    it('refuses self-DMs, unknown users and leaving', async () => {
      const [a, b] = await makeUsers(pool, 2);
      if (!a || !b) throw new Error('fixture');
      await rejectsWith(findOrCreateDirect(pool, a.id, a.id), 400, 'invalid_request');
      await rejectsWith(findOrCreateDirect(pool, a.id, randomUUID()), 404, 'user_not_found');
      await rejectsWith(findOrCreateDirect(pool, a.id, 'not-a-uuid'), 400, 'invalid_request');
      const { conversation } = await findOrCreateDirect(pool, a.id, b.id);
      await rejectsWith(leave(pool, { conversationId: conversation.id, userId: a.id }), 409, 'cannot_leave_direct');
    });
  });

  describe('groups and membership', () => {
    it('creates a group whose members all see group_created, and enforces roles', async () => {
      const [owner, admin, member, outsider] = await makeUsers(pool, 4);
      if (!owner || !admin || !member || !outsider) throw new Error('fixture');
      const g = await createGroup(pool, { creatorId: owner.id, title: '  Friends  ', memberIds: [member.id, member.id] });
      expect(g.title).toBe('Friends');
      const page = await history(pool, { conversationId: g.id, userId: member.id });
      expect(page.messages.map((m) => [m.seq, m.kind, m.meta?.event])).toEqual([[1, 'system', 'group_created']]);

      await addMember(pool, { conversationId: g.id, actorId: owner.id, userId: admin.id, role: 'admin' });
      await rejectsWith(addMember(pool, { conversationId: g.id, actorId: member.id, userId: outsider.id }), 403, 'forbidden');
      await rejectsWith(addMember(pool, { conversationId: g.id, actorId: admin.id, userId: outsider.id, role: 'admin' }), 403, 'forbidden');
      await rejectsWith(addMember(pool, { conversationId: g.id, actorId: owner.id, userId: member.id }), 409, 'already_member');
      await rejectsWith(addMember(pool, { conversationId: g.id, actorId: outsider.id, userId: outsider.id }), 404, 'not_found');
      await rejectsWith(removeMember(pool, { conversationId: g.id, actorId: admin.id, userId: owner.id }), 403, 'forbidden');
      await rejectsWith(leave(pool, { conversationId: g.id, userId: owner.id }), 409, 'owner_must_transfer');
      await rejectsWith(createGroup(pool, { creatorId: owner.id, title: '   ', memberIds: [] }), 400, 'invalid_request');
    });

    it('records joins, removals and leaves as system messages at the window edges', async () => {
      const [owner, a, b] = await makeUsers(pool, 3);
      if (!owner || !a || !b) throw new Error('fixture');
      const g = await createGroup(pool, { creatorId: owner.id, title: 'Edges', memberIds: [] });
      await send(pool, g.id, owner.id, 'before a');                                            // seq 2
      const { joinedSeq } = await addMember(pool, { conversationId: g.id, actorId: owner.id, userId: a.id }); // added = seq 3
      expect(joinedSeq).toBe(3);
      await send(pool, g.id, a.id, 'hello');                                                    // seq 4
      const { leftSeq } = await removeMember(pool, { conversationId: g.id, actorId: owner.id, userId: a.id }); // removed = seq 5
      expect(leftSeq).toBe(5);
      const seen = await history(pool, { conversationId: g.id, userId: a.id });
      expect(seen.messages.map((m) => m.meta?.event ?? m.body)).toEqual(['member_added', 'hello', 'member_removed']);
      await rejectsWith(send(pool, g.id, a.id), 403, 'read_only');
      await rejectsWith(removeMember(pool, { conversationId: g.id, actorId: owner.id, userId: a.id }), 404, 'not_member');

      await addMember(pool, { conversationId: g.id, actorId: owner.id, userId: b.id });
      const { leftSeq: bLeft } = await leave(pool, { conversationId: g.id, userId: b.id });
      const bSeen = await history(pool, { conversationId: g.id, userId: b.id });
      expect(bSeen.messages.map((m) => m.meta?.event)).toEqual(['member_added', 'member_left']);
      expect(bSeen.messages.at(-1)?.seq).toBe(bLeft);
    });
  });

  describe('messages', () => {
    it('sends, edits and deletes for everyone, each taking a change cursor value', async () => {
      const [a, b] = await makeUsers(pool, 2);
      if (!a || !b) throw new Error('fixture');
      const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
      const m1 = await send(pool, c.id, a.id, 'first');
      const m2 = await send(pool, c.id, b.id, 'second');
      expect([m1.seq, m2.seq]).toEqual([1, 2]);
      expect([m1.changeSeq, m2.changeSeq]).toEqual([1, 2]);

      const edited = await editMessage(pool, { messageId: m1.id, userId: a.id, body: 'first (edited)' });
      expect(edited).toMatchObject({ seq: 1, changeSeq: 3, body: 'first (edited)' });
      expect(edited.editedAt).toBeInstanceOf(Date);
      await rejectsWith(editMessage(pool, { messageId: m1.id, userId: b.id, body: 'hijack' }), 403, 'forbidden');

      const gone = await deleteForEveryone(pool, { messageId: m2.id, userId: b.id });
      expect(gone).toMatchObject({ seq: 2, changeSeq: 4, body: null });
      expect(await deleteForEveryone(pool, { messageId: m2.id, userId: b.id })).toEqual(gone); // idempotent
      await rejectsWith(editMessage(pool, { messageId: m2.id, userId: b.id, body: 'resurrect' }), 409, 'message_deleted');

      const changes = await catchUpByChange(pool, { conversationId: c.id, userId: a.id, afterChange: 2 });
      expect(changes.messages.map((m) => [m.seq, m.changeSeq])).toEqual([[1, 3], [2, 4]]);
      expect(changes.nextCursor).toBe(4);
      expect(changes.messages[1]?.deletedAt).toBeInstanceOf(Date);
      const none = await catchUpByChange(pool, { conversationId: c.id, userId: a.id, afterChange: 4 });
      expect(none).toEqual({ messages: [], hasMore: false, nextCursor: 4 });
    });

    it('validates bodies and ids', async () => {
      const [a, b] = await makeUsers(pool, 2);
      if (!a || !b) throw new Error('fixture');
      const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
      for (const body of ['', '   \n', 'x'.repeat(4001)]) {
        await rejectsWith(sendMessage(pool, { conversationId: c.id, senderId: a.id, clientMsgId: randomUUID(), body }), 400, 'invalid_request');
      }
      expect((await send(pool, c.id, a.id, '😀'.repeat(4000))).body).toHaveLength(8000); // 4000 code points
      await rejectsWith(sendMessage(pool, { conversationId: c.id, senderId: a.id, clientMsgId: 'nope', body: 'x' }), 400, 'invalid_request');
      await rejectsWith(sendMessage(pool, { conversationId: 'nope', senderId: a.id, clientMsgId: randomUUID(), body: 'x' }), 404, 'not_found');
    });

    it('pages history backwards and catches up forwards by seq', async () => {
      const [a, b] = await makeUsers(pool, 2);
      if (!a || !b) throw new Error('fixture');
      const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
      for (let i = 1; i <= 7; i++) await send(pool, c.id, i % 2 ? a.id : b.id, `m${String(i)}`);
      const p1 = await history(pool, { conversationId: c.id, userId: b.id, limit: 3 });
      expect(p1.messages.map((m) => m.seq)).toEqual([5, 6, 7]);
      expect(p1.hasMore).toBe(true);
      const p2 = await history(pool, { conversationId: c.id, userId: b.id, beforeSeq: 5, limit: 3 });
      expect(p2.messages.map((m) => m.seq)).toEqual([2, 3, 4]);
      const p3 = await history(pool, { conversationId: c.id, userId: b.id, beforeSeq: 2, limit: 3 });
      expect(p3).toMatchObject({ hasMore: false });
      expect(p3.messages.map((m) => m.seq)).toEqual([1]);
      const after = await catchUpBySeq(pool, { conversationId: c.id, userId: b.id, afterSeq: 4, limit: 2 });
      expect(after.messages.map((m) => m.seq)).toEqual([5, 6]);
      expect(after.hasMore).toBe(true);
    });

    it('derives unread from the read marker: others only, live only, own send marks read', async () => {
      const [a, b] = await makeUsers(pool, 2);
      if (!a || !b) throw new Error('fixture');
      const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
      await send(pool, c.id, a.id);
      const x = await send(pool, c.id, a.id);
      await send(pool, c.id, a.id);
      expect(await unreadCount(pool, c.id, b.id)).toBe(3);
      expect(await unreadCount(pool, c.id, a.id)).toBe(0); // own messages never count
      await deleteForEveryone(pool, { messageId: x.id, userId: a.id });
      expect(await unreadCount(pool, c.id, b.id)).toBe(2); // tombstones don't count

      expect(await markDelivered(pool, { conversationId: c.id, userId: b.id, seq: 3 })).toEqual({ lastReadSeq: 0, lastDeliveredSeq: 3 });
      expect(await markRead(pool, { conversationId: c.id, userId: b.id, seq: 1 })).toEqual({ lastReadSeq: 1, lastDeliveredSeq: 3 });
      expect(await unreadCount(pool, c.id, b.id)).toBe(1);

      await send(pool, c.id, b.id, 'reply'); // decision 3: replying marks everything before it read
      expect(await unreadCount(pool, c.id, b.id)).toBe(0);
      const inbox = await listConversations(pool, b.id);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ id: c.id, kind: 'direct', active: true, unread: 0, lastSeq: 4, peer: { id: a.id, handle: a.handle } });
    });
  });

  it('gives non-members a 404 on everything', async () => {
    const [a, b, stranger] = await makeUsers(pool, 3);
    if (!a || !b || !stranger) throw new Error('fixture');
    const { conversation: c } = await findOrCreateDirect(pool, a.id, b.id);
    const m = await send(pool, c.id, a.id);
    const s = { conversationId: c.id, userId: stranger.id };
    await rejectsWith(history(pool, s), 404, 'not_found');
    await rejectsWith(catchUpBySeq(pool, { ...s, afterSeq: 0 }), 404, 'not_found');
    await rejectsWith(catchUpByChange(pool, { ...s, afterChange: 0 }), 404, 'not_found');
    await rejectsWith(markRead(pool, { ...s, seq: 1 }), 404, 'not_found');
    await rejectsWith(unreadCount(pool, c.id, stranger.id), 404, 'not_found');
    await rejectsWith(send(pool, c.id, stranger.id), 404, 'not_found');
    await rejectsWith(editMessage(pool, { messageId: m.id, userId: stranger.id, body: 'x' }), 404, 'not_found');
    await rejectsWith(deleteForEveryone(pool, { messageId: m.id, userId: stranger.id }), 404, 'not_found');
    expect(await listConversations(pool, stranger.id)).toEqual([]);
  });
});
