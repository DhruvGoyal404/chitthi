import { Link, useParams } from 'react-router';
import { Avatar, Icon, PresenceDot, TopBar } from '../components/ui.js';
import { shortWhen } from '../lib/format.js';
import { conversationName, type InboxEntry } from '../lib/types.js';
import { usePresence } from '../realtime/hooks.js';
import { systemText, useConversations } from '../queries.js';
import { useMe } from '../session.js';

function preview(c: InboxEntry, meId: string | undefined): string {
  const m = c.lastMessage;
  if (!m) return c.kind === 'group' ? 'Group created' : 'Say namaste';
  if (m.kind === 'system') return systemText(m.meta, (id) => (id === meId ? 'You' : 'Someone'));
  if (m.deletedAt) return 'Message deleted';
  const kinds = m.attachmentKinds ?? [];
  const media = kinds.length === 0 ? '' : kinds.every((k) => k === 'image')
    ? (kinds.length === 1 ? 'Photo' : `${String(kinds.length)} photos`)
    : (kinds.length === 1 ? 'File' : `${String(kinds.length)} attachments`);
  const text = (m.body ?? '').replace(/\s+/g, ' ');
  const body = media && text ? `${media}: ${text}` : media || text;
  return m.senderId === meId ? `You: ${body}` : body;
}

function Row({ c, selected, meId }: { c: InboxEntry; selected: boolean; meId: string | undefined }) {
  const presence = usePresence(c.peer?.id);
  const name = conversationName(c);
  const when = c.lastMessage?.createdAt ?? c.lastMessageAt;
  return (
    <li>
      <Link to={`/c/${c.id}`} aria-current={selected ? 'page' : undefined}
        className={`flex items-center gap-3 px-3 py-2.5 hover:bg-paper-deep ${selected ? 'bg-paper-deep' : ''}`}>
        <span className="relative">
          <Avatar name={name} group={c.kind === 'group'} />
          {c.kind === 'direct' && presence && <PresenceDot online={presence.online} className="absolute -bottom-0.5 -right-0.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`truncate ${c.unread > 0 ? 'font-semibold' : 'font-medium'} text-ink`}>{name}</span>
            {when && <span className="shrink-0 text-xs text-ink-soft">{shortWhen(when)}</span>}
          </span>
          <span className="flex items-center justify-between gap-2">
            <span className={`truncate text-sm ${c.lastMessage?.deletedAt ? 'italic' : ''} text-ink-soft`}>
              {!c.active && <span className="mr-1 font-medium">(left)</span>}
              {preview(c, meId)}
            </span>
            {c.unread > 0 && (
              <span className="inline-flex min-w-6 shrink-0 items-center justify-center rounded-full bg-stamp px-1.5 text-xs font-semibold text-sheet"
                aria-label={`${String(c.unread)} unread`}>
                {c.unread > 99 ? '99+' : c.unread}
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function Inbox() {
  const me = useMe();
  const { id: selectedId } = useParams();
  const list = useConversations();
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Conversations">
      <TopBar
        title={<span className="font-[family-name:var(--font-letter)] text-lg">Chitthi</span>}
        actions={
          <>
            <Link to="/new" aria-label="New conversation" title="New conversation" className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-paper-deep"><Icon.Plus /></Link>
            <Link to="/settings" aria-label="Settings" title="Settings" className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-paper-deep"><Icon.Settings /></Link>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending && <p className="p-4 text-sm text-ink-soft">Opening your letters…</p>}
        {list.isError && <p role="alert" className="p-4 text-sm text-stamp">Could not load conversations.</p>}
        {list.data?.length === 0 && (
          <div className="p-6 text-center text-sm text-ink-soft">
            <p>No letters yet.</p>
            <Link to="/new" className="mt-2 inline-block font-medium text-ink underline">Start a conversation</Link>
          </div>
        )}
        <ul>
          {list.data?.map((c) => <Row key={c.id} c={c} selected={c.id === selectedId} meId={me.data?.id} />)}
        </ul>
      </div>
    </section>
  );
}
