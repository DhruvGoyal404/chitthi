import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../components/ui.js';
import { clock, fullWhen } from '../lib/format.js';
import type { Message } from '../lib/types.js';
import { Linkified } from './Linkified.js';
import { isPending, type Pending } from './outbox.js';
import { TickIcon } from './TickIcon.js';
import type { Tick } from './ticks.js';

type Props = {
  item: Message | Pending;
  mine: boolean;
  senderName: string | null;
  tick: Tick | null;
  infoHref: string | null;
  onEdit?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
};

/** One letter. Text only (never HTML); tombstones read "message deleted". */
export function MessageBubble({ item, mine, senderName, tick, infoHref, onEdit, onDelete, onRetry }: Props) {
  const stored = 'seq' in item ? item : null;
  const deleted = stored?.deletedAt != null;
  const body = stored ? stored.body : item.body;
  const failed = isPending(item) && item.status === 'failed' ? item : null;
  const canAct = stored !== null && mine && !deleted && stored.kind === 'text';

  return (
    <div className={`group flex px-3 py-1 ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`letter max-w-[85%] rounded-sm px-3 pb-1.5 pt-2 shadow-[0_1px_1px_rgb(0_0_0/0.08)] md:max-w-[70%] ${mine ? 'mine' : ''}`}>
        {senderName && <p className="mb-0.5 text-xs font-semibold text-seal">{senderName}</p>}
        {deleted ? (
          <p className="italic text-ink-soft">message deleted</p>
        ) : (
          <p className="whitespace-pre-wrap break-words font-[family-name:var(--font-letter)] text-[0.975rem] leading-snug text-ink">
            <Linkified text={body ?? ''} />
          </p>
        )}
        <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[0.7rem] text-ink-soft">
          {stored?.editedAt && !deleted && <span>edited</span>}
          <time dateTime={stored?.createdAt ?? item.createdAt} title={fullWhen(stored?.createdAt ?? item.createdAt)}>
            {clock(stored?.createdAt ?? item.createdAt)}
          </time>
          {tick && <TickIcon tick={tick} />}
          {canAct && <Actions onEdit={onEdit} onDelete={onDelete} infoHref={infoHref} />}
        </div>
        {failed && (
          <div className="mt-1 flex items-center justify-end gap-2 text-xs text-stamp">
            <span role="alert">{failed.error ?? failed.note ?? 'Not sent.'}</span>
            {onRetry && !failed.error && (
              <button type="button" onClick={onRetry} className="inline-flex min-h-8 items-center gap-1 rounded border border-stamp px-2 font-medium">
                <Icon.Retry width={14} height={14} /> Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Actions({ onEdit, onDelete, infoHref }: { onEdit: (() => void) | undefined; onDelete: (() => void) | undefined; infoHref: string | null }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const item = 'flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm text-ink hover:bg-paper-deep';
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label="Message options" aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setConfirming(false); }}
        className="-mr-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-ink-soft hover:bg-paper-deep">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      {open && (
        <div role="menu" aria-label="Message options" className="absolute bottom-8 right-0 z-20 w-52 overflow-hidden rounded-md border border-paper-edge bg-sheet py-1 shadow-lg">
          {confirming ? (
            <>
              <p className="px-3 py-2 text-sm text-ink">Delete for everyone? The text will be erased.</p>
              <button type="button" role="menuitem" className={`${item} text-stamp`} onClick={() => { setOpen(false); onDelete?.(); }}>
                <Icon.Trash width={16} height={16} /> Delete for everyone
              </button>
              <button type="button" role="menuitem" className={item} onClick={() => { setConfirming(false); }}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onEdit?.(); }}>
                <Icon.Edit width={16} height={16} /> Edit
              </button>
              <button type="button" role="menuitem" className={`${item} text-stamp`} onClick={() => { setConfirming(true); }}>
                <Icon.Trash width={16} height={16} /> Delete…
              </button>
              {infoHref && (
                <Link role="menuitem" to={infoHref} className={item}><Icon.Info width={16} height={16} /> Message info</Link>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
