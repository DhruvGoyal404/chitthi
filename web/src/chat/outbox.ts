import type { Attachment, Message } from '../lib/types.js';

/** A file travelling with a pending message: uploaded first, then referenced by the send. */
export type PendingFile = {
  localId: string;
  file: File;
  name: string;
  size: number;
  kind: 'image' | 'file';
  /** blob: URL of a local image, shown until the stored message replaces the bubble. */
  previewUrl: string | null;
  status: 'queued' | 'uploading' | 'done' | 'failed';
  /** 0..1 while uploading. */
  progress: number;
  attachment?: Attachment;
  error?: string;
};

/** A message I am sending: shown at once, then replaced by the stored row (matched by clientMsgId). */
export type Pending = {
  clientMsgId: string;
  conversationId: string;
  /** The text, or the caption when files are attached ('' for none). */
  body: string;
  files?: PendingFile[];
  status: 'pending' | 'failed';
  createdAt: string;
  /** Why it failed, when the server said (a retry would not help, e.g. too long). */
  error?: string;
  /** Why it failed when a retry WILL help later (e.g. sending too fast): shown with the Retry button. */
  note?: string;
};

/**
 * The timeline as shown: stored messages in seq order, then my pending/failed sends that the
 * server has not stored yet. A pending send whose clientMsgId already appears among my stored
 * messages is hidden, so whichever arrives first (the REST ack or the socket push) there is exactly
 * one bubble, and a late ack or a duplicate push changes nothing.
 */
export function timeline(stored: readonly Message[], pending: readonly Pending[], meId: string): (Message | Pending)[] {
  const mine = new Set<string>();
  for (const m of stored) if (m.senderId === meId && m.clientMsgId) mine.add(m.clientMsgId);
  return [...stored, ...pending.filter((p) => !mine.has(p.clientMsgId))];
}

export const isPending = (x: Message | Pending): x is Pending => 'status' in x;

/** Per-tab outbox. Not persisted: a reload loses unsent drafts, never sent ones. */
export class Outbox {
  private readonly items = new Map<string, Pending>();
  private readonly snapshots = new Map<string, Pending[]>();
  private readonly subs = new Set<(conversationId: string) => void>();
  private static readonly EMPTY: Pending[] = [];

  add(p: Omit<Pending, 'status'>): Pending {
    const item: Pending = { ...p, status: 'pending' };
    this.items.set(p.clientMsgId, item);
    this.changed(p.conversationId);
    return item;
  }

  /**
   * Back to pending for a retry with the same clientMsgId (idempotent on the server). Files that
   * already uploaded keep their attachment; failed ones are queued again.
   */
  retry(clientMsgId: string): Pending | undefined {
    const p = this.items.get(clientMsgId);
    if (!p) return undefined;
    const next: Pending = {
      clientMsgId: p.clientMsgId, conversationId: p.conversationId, body: p.body, createdAt: p.createdAt, status: 'pending',
      ...(p.files && { files: p.files.map((f) => (f.status === 'done' ? f : { ...f, status: 'queued' as const, progress: 0, error: undefined })) }),
    };
    this.items.set(clientMsgId, next);
    this.changed(p.conversationId);
    return next;
  }

  fail(clientMsgId: string, error?: string, note?: string): void {
    const p = this.items.get(clientMsgId);
    if (!p) return;
    this.items.set(clientMsgId, { ...p, status: 'failed', ...(error !== undefined && { error }), ...(note !== undefined && { note }) });
    this.changed(p.conversationId);
  }

  /** Upload progress and results of one file. */
  updateFile(clientMsgId: string, localId: string, patch: Partial<Omit<PendingFile, 'localId' | 'file'>>): void {
    const p = this.items.get(clientMsgId);
    if (!p?.files) return;
    this.items.set(clientMsgId, { ...p, files: p.files.map((f) => (f.localId === localId ? { ...f, ...patch } : f)) });
    this.changed(p.conversationId);
  }

  get(clientMsgId: string): Pending | undefined {
    return this.items.get(clientMsgId);
  }

  /** The server stored it (ack received), or the sender cancelled: the bubble goes, with its previews. */
  remove(clientMsgId: string): void {
    const p = this.items.get(clientMsgId);
    if (!p) return;
    this.items.delete(clientMsgId);
    for (const f of p.files ?? []) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    this.changed(p.conversationId);
  }

  /** Failed sends a retry can fix (no permanent error from the server), in every conversation. */
  retryable(): Pending[] {
    return [...this.items.values()].filter((p) => p.status === 'failed' && p.error === undefined);
  }

  list(conversationId: string): Pending[] {
    let s = this.snapshots.get(conversationId);
    if (!s) {
      s = [...this.items.values()].filter((p) => p.conversationId === conversationId);
      if (s.length === 0) s = Outbox.EMPTY;
      this.snapshots.set(conversationId, s);
    }
    return s;
  }

  subscribe(fn: (conversationId: string) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private changed(conversationId: string): void {
    this.snapshots.delete(conversationId);
    for (const fn of this.subs) fn(conversationId);
  }
}
