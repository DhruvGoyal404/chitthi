import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { Member, Message } from '../lib/types.js';
import { MessageBubble } from './MessageBubble.js';
import { isPending, type Pending } from './outbox.js';
import { tickFor } from './ticks.js';

type Row =
  | { key: string; type: 'message'; item: Message }
  | { key: string; type: 'pending'; item: Pending }
  | { key: string; type: 'divider'; count: number };

export type MessageListHandle = { scrollToBottom: () => void };

type Props = {
  conversationId: string;
  kind: 'direct' | 'group';
  meId: string;
  items: (Message | Pending)[];
  members: Member[];
  /** My read marker when the conversation was opened: the "new messages" divider goes after it. */
  initialReadSeq: number;
  myReadSeq: number;
  hasOlder: boolean;
  loadOlder: () => Promise<number>;
  nameOf: (id: unknown) => string;
  systemText: (m: Message) => string;
  onMarkRead: (seq: number) => void;
  onEdit: (m: Message) => void;
  onDelete: (m: Message) => void;
  onRetry: (p: Pending) => void;
};

const BASE = 1_000_000;

/**
 * The letter pile: virtualized, newest at the bottom, older pages prepended on scroll-up with the
 * view anchored (firstItemIndex moves down by exactly the number of rows added above).
 */
export const MessageList = forwardRef<MessageListHandle, Props>(function MessageList(p, handleRef) {
  const virtuoso = useRef<VirtuosoHandle>(null);
  const { meId, members, initialReadSeq } = p;

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    // Same definition as the API's unread count: live text from others after my read marker.
    const isUnread = (x: Message | Pending) => !isPending(x) && x.seq > initialReadSeq && x.senderId !== meId && x.kind === 'text' && x.deletedAt === null;
    const firstUnread = p.items.findIndex(isUnread);
    const unread = p.items.filter(isUnread).length;
    p.items.forEach((x, i) => {
      if (i === firstUnread) out.push({ key: 'divider', type: 'divider', count: unread });
      if (isPending(x)) out.push({ key: `p:${x.clientMsgId}`, type: 'pending', item: x });
      else out.push({ key: `m:${x.id}`, type: 'message', item: x });
    });
    return out;
  }, [p.items, initialReadSeq, meId]);

  // Anchor: the row that was first when the list mounted; everything before it was prepended.
  const [anchorKey] = useState(() => rows[0]?.key);
  const anchorIndex = Math.max(0, rows.findIndex((r) => r.key === anchorKey));
  const firstItemIndex = BASE - anchorIndex;
  const [initialIndex] = useState(() => {
    const d = rows.findIndex((r) => r.type === 'divider');
    return d >= 0 ? { index: d, align: 'start' as const } : { index: Math.max(0, rows.length - 1), align: 'end' as const };
  });

  useImperativeHandle(handleRef, () => ({
    scrollToBottom: () => { virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' }); },
  }));

  // Mark read: only messages actually on screen, only while this window is visible and focused.
  const maxVisible = useRef(0);
  const { onMarkRead, myReadSeq } = p;
  const flush = useCallback(() => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (maxVisible.current > myReadSeq) onMarkRead(maxVisible.current);
  }, [onMarkRead, myReadSeq]);
  const observer = useMemo(() => new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const seq = Number((e.target as HTMLElement).dataset.seq);
      if (seq > maxVisible.current) maxVisible.current = seq;
    }
    flush();
  }, { threshold: 0.6 }), [flush]);
  useEffect(() => () => { observer.disconnect(); }, [observer]);
  useEffect(() => {
    const again = () => { flush(); };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [flush]);
  const observe = useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    observer.observe(el);
    return () => { observer.unobserve(el); };
  }, [observer]);

  const [loadingOlder, setLoadingOlder] = useState(false);
  const startReached = () => {
    if (!p.hasOlder || loadingOlder) return;
    setLoadingOlder(true);
    void p.loadOlder().finally(() => { setLoadingOlder(false); });
  };

  const render = (_index: number, row: Row) => {
    if (row.type === 'divider') {
      return (
        <div className="flex items-center gap-3 px-4 py-2" role="separator" aria-label={`${String(row.count)} new messages`}>
          <span className="h-px flex-1 border-t border-dashed border-stamp" />
          <span className="rounded-sm border border-stamp px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-stamp">
            {row.count} new
          </span>
          <span className="h-px flex-1 border-t border-dashed border-stamp" />
        </div>
      );
    }
    if (row.type === 'pending') {
      return (
        <MessageBubble item={row.item} mine senderName={null} tick={tickFor({ pending: row.item.status }, meId, members)} infoHref={null}
          onRetry={() => { p.onRetry(row.item); }} />
      );
    }
    const m = row.item;
    if (m.kind === 'system') {
      return (
        <div ref={observe} data-seq={m.seq} className="px-4 py-1.5 text-center">
          <span className="inline-block rounded-sm bg-paper-deep px-2 py-0.5 text-xs text-ink-soft">{p.systemText(m)}</span>
        </div>
      );
    }
    const mine = m.senderId === meId;
    return (
      <div ref={observe} data-seq={m.seq}>
        <MessageBubble item={m} mine={mine}
          senderName={p.kind === 'group' && !mine ? p.nameOf(m.senderId) : null}
          tick={mine ? tickFor(m, meId, members) : null}
          infoHref={mine && p.kind === 'group' ? `/c/${p.conversationId}/m/${m.id}` : null}
          onEdit={() => { p.onEdit(m); }} onDelete={() => { p.onDelete(m); }} />
      </div>
    );
  };

  return (
    <Virtuoso
      ref={virtuoso}
      className="min-h-0 flex-1"
      data={rows}
      computeItemKey={(_i, r) => r.key}
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={initialIndex}
      startReached={startReached}
      followOutput={(atBottom) => (atBottom ? 'smooth' : false)}
      increaseViewportBy={{ top: 400, bottom: 200 }}
      itemContent={render}
      components={{
        Header: () => (
          <div className="py-3 text-center text-xs text-ink-soft">
            {loadingOlder ? 'Unfolding older letters…' : p.hasOlder ? '' : 'Beginning of the conversation'}
          </div>
        ),
        Footer: () => <div className="h-2" />,
      }}
      role="log"
      aria-label="Messages"
      aria-live="polite"
    />
  );
});
