import { describe, expect, it } from 'vitest';
import { SyncEngine, type ChangePage, type ConversationHead, type Message, type MessageEvent, type Page, type SyncApi } from './sync.js';

/** A miniature server: per-conversation seq and change counters, windows, and a call log. */
class FakeServer implements SyncApi {
  private readonly convs = new Map<string, { lastSeq: number; changeSeq: number; rows: Map<string, Message>; hidden: Set<number> }>();
  readonly calls: string[] = [];
  /** Serves pages of at most this many rows, to exercise hasMore loops. */
  pageSize = 50;

  conv(id: string) {
    let c = this.convs.get(id);
    if (!c) {
      c = { lastSeq: 0, changeSeq: 0, rows: new Map(), hidden: new Set() };
      this.convs.set(id, c);
    }
    return c;
  }

  /** Commits a message; returns the event the socket would carry. `hidden` = outside the user's window. */
  send(conversationId: string, body: string, opts: { hidden?: boolean } = {}): MessageEvent {
    const c = this.conv(conversationId);
    c.lastSeq++;
    c.changeSeq++;
    const message: Message = {
      id: `${conversationId}:${String(c.lastSeq)}`, conversationId, seq: c.lastSeq, changeSeq: c.changeSeq,
      senderId: 'u1', clientMsgId: null, kind: 'text', body, meta: null,
      createdAt: new Date(0).toISOString(), editedAt: null, deletedAt: null,
    };
    c.rows.set(message.id, message);
    if (opts.hidden) c.hidden.add(c.lastSeq);
    return { conversationId, seq: message.seq, changeSeq: c.changeSeq, message };
  }

  edit(conversationId: string, seq: number, body: string | null): MessageEvent {
    const c = this.conv(conversationId);
    const old = [...c.rows.values()].find((m) => m.seq === seq);
    if (!old) throw new Error('no such message');
    c.changeSeq++;
    const message: Message = body === null
      ? { ...old, body: null, changeSeq: c.changeSeq, deletedAt: new Date(1).toISOString() }
      : { ...old, body, changeSeq: c.changeSeq, editedAt: new Date(1).toISOString() };
    c.rows.set(message.id, message);
    return { conversationId, seq, changeSeq: c.changeSeq, message };
  }

  private visible(c: { rows: Map<string, Message>; hidden: Set<number> }) {
    return [...c.rows.values()].filter((m) => !c.hidden.has(m.seq));
  }

  listConversations(): Promise<ConversationHead[]> {
    this.calls.push('list');
    return Promise.resolve([...this.convs].map(([id, c]) => ({ id, lastSeq: c.lastSeq, changeSeq: c.changeSeq })));
  }

  catchUpBySeq(conversationId: string, afterSeq: number): Promise<Page> {
    this.calls.push(`seq:${conversationId}>${String(afterSeq)}`);
    const rows = this.visible(this.conv(conversationId)).filter((m) => m.seq > afterSeq).sort((a, b) => a.seq - b.seq);
    return Promise.resolve({ messages: rows.slice(0, this.pageSize), hasMore: rows.length > this.pageSize });
  }

  catchUpByChange(conversationId: string, afterChange: number): Promise<ChangePage> {
    this.calls.push(`change:${conversationId}>${String(afterChange)}`);
    const c = this.conv(conversationId);
    const rows = this.visible(c).filter((m) => m.changeSeq > afterChange).sort((a, b) => a.changeSeq - b.changeSeq);
    const page = rows.slice(0, this.pageSize);
    const hasMore = rows.length > this.pageSize;
    return Promise.resolve({ messages: page, hasMore, nextCursor: hasMore ? (page.at(-1)?.changeSeq ?? afterChange) : c.changeSeq });
  }
}

/** A socket double: the test delivers (or drops) server events and inspects what the client emitted. */
class FakeSocket {
  private readonly handlers = new Map<string, ((p: never) => void)[]>();
  readonly emitted: { event: string; payload: unknown }[] = [];
  on(event: string, handler: (p: never) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
  }
  deliver(event: string, payload?: unknown) {
    for (const h of this.handlers.get(event) ?? []) h(payload as never);
  }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const server = new FakeServer();
  const socket = new FakeSocket();
  const engine = new SyncEngine(server, socket, { ackDelayMs: 0 });
  engine.track('c1', { lastSeq: 0, changeCursor: 0 });
  server.conv('c1');
  return { server, socket, engine };
}
const bodies = (engine: SyncEngine, id = 'c1') => engine.messages(id).map((m) => m.body);

describe('SyncEngine', () => {
  it('applies in-order pushes without any REST calls, and acks delivery coalesced', async () => {
    const { server, socket, engine } = setup();
    for (const b of ['a', 'b', 'c']) socket.deliver('message:new', server.send('c1', b));
    await engine.settled();
    await tick();
    expect(bodies(engine)).toEqual(['a', 'b', 'c']);
    expect(engine.get('c1')).toMatchObject({ lastSeq: 3, changeCursor: 3 });
    expect(server.calls).toEqual([]);
    expect(socket.emitted).toEqual([{ event: 'delivered', payload: { conversationId: 'c1', seq: 3 } }]); // one ack for three messages
  });

  it('ignores duplicates', async () => {
    const { server, socket, engine } = setup();
    const e = server.send('c1', 'once');
    socket.deliver('message:new', e);
    socket.deliver('message:new', e);
    await engine.settled();
    expect(bodies(engine)).toEqual(['once']);
    expect(server.calls).toEqual([]);
  });

  it('repairs a gap with one seq catch-up and applies events that arrive meanwhile in order', async () => {
    const { server, socket, engine } = setup();
    socket.deliver('message:new', server.send('c1', 'm1'));
    server.send('c1', 'm2'); // lost
    server.send('c1', 'm3'); // lost
    socket.deliver('message:new', server.send('c1', 'm4')); // gap → catch-up
    socket.deliver('message:new', server.send('c1', 'm5')); // arrives during the catch-up
    await engine.settled();
    expect(bodies(engine)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(engine.get('c1')).toMatchObject({ lastSeq: 5, changeCursor: 5 });
    expect(server.calls).toEqual(['seq:c1>1']);
  });

  it('pages through a long catch-up', async () => {
    const { server, socket, engine } = setup();
    server.pageSize = 2;
    for (let i = 1; i <= 6; i++) server.send('c1', `m${String(i)}`);
    socket.deliver('message:new', server.send('c1', 'm7'));
    await engine.settled();
    expect(bodies(engine)).toHaveLength(7);
    expect(server.calls.filter((c) => c.startsWith('seq'))).toEqual(['seq:c1>0', 'seq:c1>2', 'seq:c1>4', 'seq:c1>6']);
  });

  it('moves past seqs outside the user\'s windows instead of refetching forever', async () => {
    const { server, socket, engine } = setup();
    socket.deliver('message:new', server.send('c1', 'visible 1'));
    server.send('c1', 'while away', { hidden: true });
    socket.deliver('message:new', server.send('c1', 'visible 3'));
    await engine.settled();
    socket.deliver('message:new', server.send('c1', 'visible 4'));
    await engine.settled();
    expect(bodies(engine)).toEqual(['visible 1', 'visible 3', 'visible 4']);
    expect(engine.get('c1')?.lastSeq).toBe(4);
    expect(server.calls.filter((c) => c.startsWith('seq'))).toEqual(['seq:c1>1']);
  });

  it('repairs a missed edit or delete through the change cursor', async () => {
    const { server, socket, engine } = setup();
    socket.deliver('message:new', server.send('c1', 'draft'));
    socket.deliver('message:new', server.send('c1', 'oops'));
    server.edit('c1', 1, 'final'); // lost
    socket.deliver('message:updated', server.edit('c1', 2, null)); // delete arrives: change gap
    await engine.settled();
    expect(bodies(engine)).toEqual(['final', null]);
    expect(engine.get('c1')?.changeCursor).toBe(4);
    expect(server.calls).toEqual(['change:c1>2']);
  });

  it('still fetches changes when a seq gap also hid an edit of an older message', async () => {
    const { server, socket, engine } = setup();
    socket.deliver('message:new', server.send('c1', 'm1 v1'));
    server.send('c1', 'm2');          // lost: change 2
    server.edit('c1', 1, 'm1 v2');    // lost: change 3, invisible to a seq catch-up
    socket.deliver('message:new', server.send('c1', 'm3')); // seq gap and change gap
    await engine.settled();
    expect(bodies(engine)).toEqual(['m1 v2', 'm2', 'm3']);
    expect(engine.get('c1')).toMatchObject({ lastSeq: 3, changeCursor: 4 });
    expect(server.calls).toEqual(['seq:c1>1', 'change:c1>2']);
  });

  it('never lets a stale event undo an edit or resurrect deleted text', async () => {
    const { server, socket, engine } = setup();
    const original = server.send('c1', 'secret');
    socket.deliver('message:new', original);
    socket.deliver('message:updated', server.edit('c1', 1, null));
    socket.deliver('message:new', original); // replayed late
    await engine.settled();
    expect(bodies(engine)).toEqual([null]);
  });

  it('on reconnect, fetches the list and catches up only the conversations that differ', async () => {
    const { server, socket, engine } = setup();
    engine.track('c2', { lastSeq: 0, changeCursor: 0 });
    engine.track('c3', { lastSeq: 0, changeCursor: 0 });
    for (const id of ['c1', 'c2', 'c3']) socket.deliver('message:new', server.send(id, `${id} hello`));
    await engine.settled();
    server.calls.length = 0;

    // While offline: c2 gets a message, c3 an edit, c1 nothing; c4 is new.
    server.send('c2', 'missed');
    server.edit('c3', 1, 'c3 edited');
    server.send('c4', 'new conversation');
    socket.deliver('connect');
    await tick(20);
    await engine.settled();

    // c2: the seq catch-up also accounts for change 2, so no change fetch; c3: only the edit is missing.
    expect(server.calls.sort()).toEqual(['change:c3>1', 'list', 'seq:c2>1']);
    expect(bodies(engine, 'c2')).toEqual(['c2 hello', 'missed']);
    expect(bodies(engine, 'c3')).toEqual(['c3 edited']);
    expect(engine.get('c4')).toMatchObject({ lastSeq: 1, changeCursor: 1 }); // tracked; history loads when opened
  });

  it('treats a server resync like a reconnect', async () => {
    const { server, socket, engine } = setup();
    server.send('c1', 'lost while the server listener was down');
    socket.deliver('resync');
    await tick(20);
    await engine.settled();
    expect(bodies(engine)).toEqual(['lost while the server listener was down']);
    expect(engine.stats).toMatchObject({ listFetches: 1, seqCatchUps: 1 });
  });
});
