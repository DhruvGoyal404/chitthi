/**
 * Client sync contract (docs/REALTIME.md §6). Transport-agnostic: the frontend plugs in the
 * Socket.IO client and the REST client; tests plug in fakes.
 *
 * Per conversation the client keeps:
 *   - lastSeq: every message the user can see with seq ≤ lastSeq is stored;
 *   - changeCursor: every change (insert, edit, delete) with change value ≤ changeCursor is applied.
 * Rules:
 *   - message:new with seq = lastSeq + 1 is applied; seq ≤ lastSeq is a duplicate (only a newer
 *     row version is kept); a larger seq is a gap → REST catch-up by seq from lastSeq.
 *   - every event's changeSeq is checked against changeCursor the same way; a gap → REST catch-up
 *     by change cursor (this is how a missed edit or delete is repaired).
 *   - a message row is replaced only by a version with a higher changeSeq, so stale or repeated
 *     events can never undo an edit or resurrect deleted text.
 *   - events for a conversation are handled one at a time, so events that arrive during a
 *     catch-up are applied after it, without duplicates or holes.
 *   - on (re)connect or `resync`, fetch the conversation list and catch up only the
 *     conversations whose lastSeq / changeSeq differ from ours.
 *   - after storing messages, acknowledge delivery up to lastSeq (`delivered` event), coalesced per
 *     conversation over ackDelayMs: the server rate-limits inbound events, and one ack per message
 *     in a busy group would exceed it.
 */

export type Message = {
  id: string;
  conversationId: string;
  seq: number;
  changeSeq: number;
  senderId: string | null;
  clientMsgId: string | null;
  kind: 'text' | 'system';
  body: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

export type MessageEvent = { conversationId: string; seq: number; changeSeq: number; message: Message };
export type ConversationHead = { id: string; lastSeq: number; changeSeq: number };
export type Page = { messages: Message[]; hasMore: boolean };
export type ChangePage = Page & { nextCursor: number };

export interface SyncApi {
  listConversations(): Promise<ConversationHead[]>;
  catchUpBySeq(conversationId: string, afterSeq: number): Promise<Page>;
  catchUpByChange(conversationId: string, afterChange: number): Promise<ChangePage>;
}

/** The subset of a Socket.IO client the engine needs. */
export interface SyncSocket {
  on(event: string, handler: (payload: never) => void): unknown;
  emit(event: string, payload: unknown): unknown;
}

export type ConversationState = {
  lastSeq: number;
  changeCursor: number;
  /** By message id; a row is only ever replaced by a higher changeSeq. */
  messages: Map<string, Message>;
  /** Change values seen above changeCursor; the cursor advances over contiguous runs of them. */
  seenChanges: Set<number>;
};

export type SyncListener = (conversationId: string) => void;

export class SyncEngine {
  private readonly state = new Map<string, ConversationState>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<SyncListener>();
  /** Counters for tests and diagnostics. */
  readonly stats = { seqCatchUps: 0, changeCatchUps: 0, listFetches: 0 };

  private readonly pendingAcks = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly api: SyncApi,
    private readonly socket: SyncSocket,
    private readonly opts: { ackDelayMs: number } = { ackDelayMs: 300 },
  ) {
    socket.on('message:new', (e: MessageEvent) => { this.enqueue(e.conversationId, () => this.onEvent(e)); });
    socket.on('message:updated', (e: MessageEvent) => { this.enqueue(e.conversationId, () => this.onEvent(e)); });
    socket.on('resync', () => { void this.resyncAll(); });
    socket.on('connect', () => { void this.resyncAll(); });
  }

  /** Starts tracking a conversation from a known point (e.g. after loading its newest history page). */
  track(conversationId: string, from: { lastSeq: number; changeCursor: number; messages?: Message[] }): void {
    const s: ConversationState = { lastSeq: from.lastSeq, changeCursor: from.changeCursor, messages: new Map(), seenChanges: new Set() };
    for (const m of from.messages ?? []) s.messages.set(m.id, m);
    this.state.set(conversationId, s);
  }

  get(conversationId: string): ConversationState | undefined {
    return this.state.get(conversationId);
  }

  /** Messages of a conversation in seq order. */
  messages(conversationId: string): Message[] {
    return [...(this.state.get(conversationId)?.messages.values() ?? [])].sort((a, b) => a.seq - b.seq);
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once everything queued for this conversation (or all of them) has been handled. */
  async settled(conversationId?: string): Promise<void> {
    if (conversationId) {
      await this.chains.get(conversationId);
      return;
    }
    await Promise.all([...this.chains.values()]);
  }

  /** Reconnect / resync: catch up only the conversations whose heads differ from ours. */
  async resyncAll(): Promise<void> {
    this.stats.listFetches++;
    const heads = await this.api.listConversations();
    await Promise.all(heads.map((h) => new Promise<void>((resolve) => {
      this.enqueue(h.id, async () => {
        const s = this.state.get(h.id);
        if (!s) {
          // Not loaded yet: start from the server's head; history is fetched when it is opened.
          this.track(h.id, { lastSeq: h.lastSeq, changeCursor: h.changeSeq });
        } else if (h.lastSeq > s.lastSeq || h.changeSeq > s.changeCursor) {
          if (h.lastSeq > s.lastSeq) await this.catchUpSeq(h.id, s);
          if (h.changeSeq > s.changeCursor) await this.catchUpChanges(h.id, s);
          this.changed(h.id, s);
        }
        resolve();
      });
    })));
  }

  private enqueue(conversationId: string, task: () => Promise<void>): void {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    const nextTask = prev.then(task).catch((err: unknown) => {
      console.error('sync failed', conversationId, err);
    });
    this.chains.set(conversationId, nextTask);
  }

  private async onEvent(e: MessageEvent): Promise<void> {
    const s = this.state.get(e.conversationId);
    if (!s) return; // not tracked yet: the conversation list (resyncAll) will introduce it
    this.apply(s, [e.message]);
    if (e.seq === s.lastSeq + 1) s.lastSeq = e.seq;
    else if (e.seq > s.lastSeq) await this.catchUpSeq(e.conversationId, s);

    // The event and any rows fetched above may already account for every change up to e.changeSeq;
    // only a remaining hole (e.g. a missed edit of an older message) needs a change catch-up.
    this.see(s, e.changeSeq);
    if (e.changeSeq > s.changeCursor) await this.catchUpChanges(e.conversationId, s);
    this.changed(e.conversationId, s);
  }

  private async catchUpSeq(conversationId: string, s: ConversationState): Promise<void> {
    this.stats.seqCatchUps++;
    for (;;) {
      const page = await this.api.catchUpBySeq(conversationId, s.lastSeq);
      this.apply(s, page.messages);
      // Seqs outside the user's windows never arrive; the frontier moves past them.
      const top = page.messages.at(-1)?.seq;
      if (top !== undefined && top > s.lastSeq) s.lastSeq = top;
      if (!page.hasMore) return;
    }
  }

  private async catchUpChanges(conversationId: string, s: ConversationState): Promise<void> {
    this.stats.changeCatchUps++;
    for (;;) {
      const page = await this.api.catchUpByChange(conversationId, s.changeCursor);
      this.apply(s, page.messages);
      s.changeCursor = Math.max(s.changeCursor, page.nextCursor);
      this.see(s, s.changeCursor);
      if (!page.hasMore) return;
    }
  }

  private apply(s: ConversationState, rows: Message[]): void {
    for (const m of rows) {
      const current = s.messages.get(m.id);
      if (!current || m.changeSeq > current.changeSeq) s.messages.set(m.id, m);
      this.see(s, m.changeSeq);
    }
  }

  /**
   * Records a change value as applied and advances the cursor over the contiguous run. Sound because
   * each change value belongs to exactly one row change, and holding a row at changeSeq k (or later)
   * means change k is applied.
   */
  private see(s: ConversationState, change: number): void {
    if (change > s.changeCursor) s.seenChanges.add(change);
    while (s.seenChanges.delete(s.changeCursor + 1)) s.changeCursor++;
    for (const c of s.seenChanges) if (c <= s.changeCursor) s.seenChanges.delete(c);
  }

  private changed(conversationId: string, s: ConversationState): void {
    for (const l of this.listeners) l(conversationId);
    if (this.pendingAcks.has(conversationId)) return;
    this.pendingAcks.set(conversationId, setTimeout(() => {
      this.pendingAcks.delete(conversationId);
      this.socket.emit('delivered', { conversationId, seq: s.lastSeq });
    }, this.opts.ackDelayMs));
  }
}
