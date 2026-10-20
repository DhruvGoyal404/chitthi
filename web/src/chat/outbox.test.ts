import { describe, expect, it } from 'vitest';
import type { Message } from '../lib/types.js';
import { SyncEngine, type ChangePage, type ConversationHead, type Page, type SyncApi, type SyncSocket } from '../sync/sync.js';
import { isPending, Outbox, timeline } from './outbox.js';

const ME = 'me';
const noApi: SyncApi = {
  listConversations: () => Promise.resolve<ConversationHead[]>([]),
  head: (id) => Promise.resolve({ id, lastSeq: 0, changeSeq: 0 }),
  history: () => Promise.resolve<Page>({ messages: [], hasMore: false }),
  catchUpBySeq: () => Promise.resolve<Page>({ messages: [], hasMore: false }),
  catchUpByChange: (_id, after) => Promise.resolve<ChangePage>({ messages: [], hasMore: false, nextCursor: after }),
};
class Socket implements SyncSocket {
  private readonly h = new Map<string, ((p: never) => void)[]>();
  on(e: string, fn: (p: never) => void) { this.h.set(e, [...(this.h.get(e) ?? []), fn]); }
  emit() { /* acks are not under test here */ }
  push(e: string, p: unknown) { for (const fn of this.h.get(e) ?? []) fn(p as never); }
}

const stored = (seq: number, clientMsgId: string, body: string, changeSeq = seq): Message => ({
  id: `m${String(seq)}`, conversationId: 'c', seq, changeSeq, senderId: ME, clientMsgId, kind: 'text', body, meta: null,
  createdAt: new Date(0).toISOString(), editedAt: null, deletedAt: null,
});

function setup() {
  const socket = new Socket();
  const engine = new SyncEngine(noApi, socket, { ackDelayMs: 0 });
  engine.track('c', { lastSeq: 0, changeCursor: 0 });
  const outbox = new Outbox();
  const view = () => timeline(engine.messages('c'), outbox.list('c'), ME).map((x) => (isPending(x) ? `pending:${x.body}` : `#${String(x.seq)}:${x.body ?? '∅'}`));
  return { socket, engine, outbox, view };
}

describe('optimistic send reconciliation', () => {
  it('ack before push: pending → one stored bubble; the late push changes nothing', async () => {
    const { socket, engine, outbox, view } = setup();
    outbox.add({ clientMsgId: 'k1', conversationId: 'c', body: 'hi', createdAt: '' });
    expect(view()).toEqual(['pending:hi']);
    const row = stored(1, 'k1', 'hi');
    await engine.ingestAck(row); // REST response
    outbox.remove('k1');
    expect(view()).toEqual(['#1:hi']);
    socket.push('message:new', { conversationId: 'c', seq: 1, changeSeq: 1, message: row });
    await engine.settled();
    expect(view()).toEqual(['#1:hi']);
  });

  it('push before ack: the stored row hides the pending one at once; the late ack is a no-op', async () => {
    const { socket, engine, outbox, view } = setup();
    outbox.add({ clientMsgId: 'k1', conversationId: 'c', body: 'hi', createdAt: '' });
    const row = stored(1, 'k1', 'hi');
    socket.push('message:new', { conversationId: 'c', seq: 1, changeSeq: 1, message: row });
    await engine.settled();
    expect(view()).toEqual(['#1:hi']); // outbox still holds it, the timeline hides it
    await engine.ingestAck(row);
    outbox.remove('k1');
    expect(view()).toEqual(['#1:hi']);
  });

  it('duplicate pushes and a retried send (same client id) still give one bubble', async () => {
    const { socket, engine, outbox, view } = setup();
    outbox.add({ clientMsgId: 'k1', conversationId: 'c', body: 'once', createdAt: '' });
    outbox.fail('k1');
    expect(outbox.retryable().map((p) => p.clientMsgId)).toEqual(['k1']);
    outbox.retry('k1');
    const row = stored(1, 'k1', 'once');
    for (let i = 0; i < 3; i++) socket.push('message:new', { conversationId: 'c', seq: 1, changeSeq: 1, message: row });
    await engine.ingestAck(row);
    await engine.ingestAck(row); // the server returned the original for the retry (duplicate: true)
    outbox.remove('k1');
    expect(view()).toEqual(['#1:once']);
  });

  it('keeps pending sends after stored ones, in the order written; a permanent failure is not retryable', () => {
    const { outbox, view } = setup();
    outbox.add({ clientMsgId: 'a', conversationId: 'c', body: 'first', createdAt: '' });
    outbox.add({ clientMsgId: 'b', conversationId: 'c', body: 'second', createdAt: '' });
    outbox.fail('b', 'Messages are 1–4000 characters');
    expect(view()).toEqual(['pending:first', 'pending:second']);
    expect(outbox.retryable()).toEqual([]);
  });

  it('a rate-limited send is failed but retryable, with the reason kept for the bubble', () => {
    const { outbox } = setup();
    outbox.add({ clientMsgId: 'r', conversationId: 'c', body: 'quick', createdAt: '' });
    outbox.fail('r', undefined, "You're sending quickly. Wait a moment, then retry.");
    expect(outbox.list('c')[0]).toMatchObject({ status: 'failed', note: "You're sending quickly. Wait a moment, then retry." });
    expect(outbox.retryable().map((p) => p.clientMsgId)).toEqual(['r']);
    expect(outbox.retry('r')).not.toHaveProperty('note'); // a retry clears it
  });

  it('an edit that arrives before the stale original push is never undone', async () => {
    const { socket, engine, view } = setup();
    const v1 = stored(1, 'k1', 'draft');
    const v2 = { ...stored(1, 'k1', 'final', 2), editedAt: new Date(1).toISOString() };
    await engine.ingestAck(v2);
    socket.push('message:new', { conversationId: 'c', seq: 1, changeSeq: 1, message: v1 });
    await engine.settled();
    expect(view()).toEqual(['#1:final']);
  });
});
