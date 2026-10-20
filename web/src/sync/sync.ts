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
 *   - a push for a conversation we don't track yet starts tracking it from zero (and catches up).
 *   - on (re)connect (`ready`: the server has joined our rooms) or `resync`, fetch the conversation
 *     list and catch up only the conversations whose lastSeq / changeSeq differ from ours.
 *   - a REST send response (the ack) goes through the same rules as a push.
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
/** A conversation's head; `deliveredSeq` is this user's delivered marker (from the list). */
export type ConversationHead = { id: string; lastSeq: number; changeSeq: number; deliveredSeq?: number };
export type Page = { messages: Message[]; hasMore: boolean };
export type ChangePage = Page & { nextCursor: number };

export interface SyncApi {
  listConversations(): Promise<ConversationHead[]>;
  /** Current head of one conversation (fetched before its newest history page). */
  head(conversationId: string): Promise<ConversationHead>;
  /** History page before `beforeSeq` (newest page when undefined), oldest first. */
  history(conversationId: string, beforeSeq?: number): Promise<Page>;
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
  /** Older history: the lowest seq loaded, and whether anything visible lies below it. */
  oldestLoaded: number | null;
  hasOlder: boolean;
  historyLoaded: boolean;
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
    socket.on('ready', () => { void this.resyncAll(); });
  }

  /** Starts tracking a conversation from a known point (e.g. after loading its newest history page). */
  track(conversationId: string, from: { lastSeq: number; changeCursor: number; messages?: Message[] }): void {
    const s: ConversationState = {
      lastSeq: from.lastSeq, changeCursor: from.changeCursor, messages: new Map(), seenChanges: new Set(),
      oldestLoaded: null, hasOlder: false, historyLoaded: false,
    };
    for (const m of from.messages ?? []) s.messages.set(m.id, m);
    this.state.set(conversationId, s);
  }

  get(conversationId: string): ConversationState | undefined {
    return this.state.get(conversationId);
  }

  private readonly snapshots = new Map<string, Message[]>();
  private static readonly EMPTY: Message[] = [];

  /** Messages of a conversation in seq order. Stable between changes (for useSyncExternalStore). */
  messages(conversationId: string): Message[] {
    const cached = this.snapshots.get(conversationId);
    if (cached) return cached;
    const s = this.state.get(conversationId);
    if (!s) return SyncEngine.EMPTY;
    const list = [...s.messages.values()].sort((a, b) => a.seq - b.seq);
    this.snapshots.set(conversationId, list);
    return list;
  }

  /**
   * Opens a conversation: head first, then the newest page, so nothing that changes in between can
   * be skipped (the cursor may be a little behind, which only costs a catch-up). Idempotent.
   */
  loadLatest(conversationId: string): Promise<void> {
    return new Promise((resolve) => {
      this.enqueue(conversationId, async () => {
        try {
          let s = this.state.get(conversationId);
          if (s?.historyLoaded) return;
          const head = await this.api.head(conversationId);
          const page = await this.api.history(conversationId);
          if (!s) {
            this.track(conversationId, { lastSeq: head.lastSeq, changeCursor: head.changeSeq });
            s = this.state.get(conversationId);
          }
          if (!s) return;
          this.apply(s, page.messages);
          const top = page.messages.at(-1)?.seq ?? 0;
          if (top > s.lastSeq) s.lastSeq = top;
          s.oldestLoaded = page.messages[0]?.seq ?? null;
          s.hasOlder = page.hasMore;
          s.historyLoaded = true;
          // A head newer than the page (something arrived in between) is repaired like any gap.
          if (head.lastSeq > s.lastSeq) await this.catchUpSeq(conversationId, s);
          this.changed(conversationId, s);
        } finally {
          resolve();
        }
      });
    });
  }

  /** Loads the next older page (infinite scroll upwards). Resolves with how many were added. */
  loadOlder(conversationId: string): Promise<number> {
    return new Promise((resolve) => {
      this.enqueue(conversationId, async () => {
        let added = 0;
        try {
          const s = this.state.get(conversationId);
          if (!s?.hasOlder || s.oldestLoaded === null) return;
          const page = await this.api.history(conversationId, s.oldestLoaded);
          const before = s.messages.size;
          this.apply(s, page.messages);
          added = s.messages.size - before;
          s.oldestLoaded = page.messages[0]?.seq ?? s.oldestLoaded;
          s.hasOlder = page.hasMore;
          this.changed(conversationId, s, false);
        } finally {
          resolve(added);
        }
      });
    });
  }

  /** A REST send/edit/delete response: same rules as a push (the push may come before or after). */
  ingestAck(message: Message): Promise<void> {
    return new Promise((resolve) => {
      this.enqueue(message.conversationId, async () => {
        try {
          await this.onEvent({ conversationId: message.conversationId, seq: message.seq, changeSeq: message.changeSeq, message });
        } finally {
          resolve();
        }
      });
    });
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
          // Not loaded yet: history is fetched when it is opened. Start from our delivered marker, so
          // the (usually few) messages we have never received are fetched now and acknowledged:
          // "delivered" means this device holds them. Older edits need no catch-up.
          const from = Math.min(h.deliveredSeq ?? h.lastSeq, h.lastSeq);
          this.track(h.id, { lastSeq: from, changeCursor: h.changeSeq });
          const t = this.state.get(h.id);
          if (t && h.lastSeq > from) {
            await this.catchUpSeq(h.id, t);
            this.changed(h.id, t);
          }
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
    let s = this.state.get(e.conversationId);
    if (!s) {
      // A conversation that appeared since the last resync (e.g. someone started a DM with us):
      // track it from the beginning, so the gap check below fetches everything we may see.
      this.track(e.conversationId, { lastSeq: 0, changeCursor: 0 });
      s = this.state.get(e.conversationId);
      if (!s) return;
    }
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

  private changed(conversationId: string, s: ConversationState, ack = true): void {
    this.snapshots.delete(conversationId);
    for (const l of this.listeners) l(conversationId);
    if (!ack || this.pendingAcks.has(conversationId)) return;
    this.pendingAcks.set(conversationId, setTimeout(() => {
      this.pendingAcks.delete(conversationId);
      this.socket.emit('delivered', { conversationId, seq: s.lastSeq });
    }, this.opts.ackDelayMs));
  }
}
