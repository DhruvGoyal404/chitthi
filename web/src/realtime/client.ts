import type { QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { api } from '../lib/api.js';
import type { ConversationDetail, InboxEntry, Message, PresenceEvent, ReceiptEvent, TypingEvent } from '../lib/types.js';
import { SyncEngine, type ChangePage, type ConversationHead, type Page, type SyncApi } from '../sync/sync.js';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** A tiny observable value for useSyncExternalStore. */
export class Store<T> {
  private readonly subs = new Set<() => void>();
  constructor(private value: T) {}
  get = (): T => this.value;
  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const s of this.subs) s();
  }
  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
}

/** REST adapter for the sync engine; also keeps TanStack Query's caches warm with what it fetched. */
function restApi(qc: QueryClient): SyncApi {
  return {
    async listConversations(): Promise<ConversationHead[]> {
      const { conversations } = await api<{ conversations: InboxEntry[] }>('/conversations');
      qc.setQueryData(['conversations'], conversations);
      return conversations.map((c) => ({ id: c.id, lastSeq: c.lastSeq, changeSeq: c.changeSeq }));
    },
    async head(id): Promise<ConversationHead> {
      const { conversation } = await api<{ conversation: ConversationDetail }>(`/conversations/${id}`);
      qc.setQueryData(['conversation', id], conversation);
      return { id, lastSeq: conversation.lastSeq, changeSeq: conversation.changeSeq };
    },
    history: (id, beforeSeq) => api<Page>(`/conversations/${id}/messages${beforeSeq === undefined ? '' : `?before=${String(beforeSeq)}`}`),
    catchUpBySeq: (id, afterSeq) => api<Page>(`/conversations/${id}/messages?after=${String(afterSeq)}`),
    catchUpByChange: (id, afterChange) => api<ChangePage>(`/conversations/${id}/changes?after=${String(afterChange)}`),
  };
}

type TypingMap = ReadonlyMap<string, ReadonlyMap<string, number>>; // conversation → user → expiresAt

/**
 * Everything live for one signed-in tab. Each tab has its own socket and engine; the server is the
 * source of truth (sends are idempotent by client message id), so tabs never need to coordinate.
 */
export class RealtimeClient {
  readonly socket: Socket;
  readonly engine: SyncEngine;
  readonly connection = new Store<ConnectionState>('connecting');
  readonly presence = new Store<ReadonlyMap<string, PresenceEvent>>(new Map());
  readonly typing = new Store<TypingMap>(new Map());
  private inboxTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onOffline = () => { this.connection.set('offline'); this.socket.disconnect(); };
  private readonly onOnline = () => { this.connection.set('reconnecting'); this.socket.connect(); };

  constructor(private readonly qc: QueryClient) {
    this.socket = io({ path: '/api/socket.io', transports: ['websocket'], withCredentials: true, autoConnect: false });
    this.engine = new SyncEngine(restApi(qc), this.socket);
    const s = this.socket;

    s.on('ready', () => { this.connection.set('live'); });
    s.on('disconnect', () => { this.connection.set(navigator.onLine ? 'reconnecting' : 'offline'); });
    s.on('connect_error', () => { this.connection.set(navigator.onLine ? 'reconnecting' : 'offline'); });
    s.on('resync', () => { this.refreshInbox(); });

    s.on('message:new', () => { this.refreshInbox(); });
    s.on('message:updated', () => { this.refreshInbox(); });
    s.on('read:updated', (e: ReceiptEvent) => { this.onReceipt(e, 'lastReadSeq'); this.refreshInbox(); });
    s.on('delivered:updated', (e: ReceiptEvent) => { this.onReceipt(e, 'lastDeliveredSeq'); });

    s.on('presence:snapshot', (p: { users: PresenceEvent[] }) => { this.presence.set(new Map(p.users.map((u) => [u.userId, u]))); });
    s.on('presence:update', (p: { users: PresenceEvent[] }) => { this.upsertPresence(p.users); });
    s.on('presence', (e: PresenceEvent) => { this.upsertPresence([e]); });
    s.on('typing', (e: TypingEvent) => { this.onTyping(e); });

  }

  /** Connects, and follows the browser's online/offline events. Restartable after stop(). */
  start(): void {
    // The browser knows before the socket does: go offline at once, and come back on 'online'.
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('online', this.onOnline);
    if (!navigator.onLine) {
      this.connection.set('offline');
      return;
    }
    this.socket.connect();
  }

  stop(): void {
    clearTimeout(this.inboxTimer);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('online', this.onOnline);
    this.socket.disconnect();
  }

  /** Typing on/off for a conversation; the server checks membership and relays it. */
  sendTyping(conversationId: string, typing: boolean): void {
    if (this.socket.connected) this.socket.emit('typing', { conversationId, typing });
  }

  /** Feeds a REST response (send/edit/delete) into the engine: the ack is applied like a push. */
  ack(message: Message): Promise<void> {
    return this.engine.ingestAck(message);
  }

  private refreshInbox(): void {
    clearTimeout(this.inboxTimer);
    this.inboxTimer = setTimeout(() => { void this.qc.invalidateQueries({ queryKey: ['conversations'] }); }, 250);
  }

  private onReceipt(e: ReceiptEvent, field: 'lastReadSeq' | 'lastDeliveredSeq'): void {
    this.qc.setQueryData<ConversationDetail>(['conversation', e.conversationId], (c) => {
      if (!c) return c;
      return {
        ...c,
        members: c.members.map((m) => {
          if (m.userId !== e.userId) return m;
          // Markers only move forward; a delivered marker is never behind the read marker.
          const next = { ...m, [field]: Math.max(m[field], e.seq) };
          if (field === 'lastReadSeq') next.lastDeliveredSeq = Math.max(next.lastDeliveredSeq, e.seq);
          return next;
        }),
      };
    });
  }

  private upsertPresence(users: PresenceEvent[]): void {
    const next = new Map(this.presence.get());
    for (const u of users) next.set(u.userId, u);
    this.presence.set(next);
  }

  private onTyping(e: TypingEvent): void {
    const next = new Map(this.typing.get());
    const users = new Map(next.get(e.conversationId) ?? []);
    if (e.typing) users.set(e.userId, Date.now() + e.ttlMs);
    else users.delete(e.userId);
    next.set(e.conversationId, users);
    this.typing.set(next);
    if (e.typing) {
      // Expire on our own too, in case the "stopped" event is lost.
      setTimeout(() => {
        const cur = this.typing.get().get(e.conversationId)?.get(e.userId);
        if (cur !== undefined && cur <= Date.now()) this.onTyping({ ...e, typing: false });
      }, e.ttlMs + 50);
    }
  }
}
