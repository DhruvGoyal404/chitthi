import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Composer } from '../chat/Composer.js';
import { MessageList, type MessageListHandle } from '../chat/MessageList.js';
import { timeline } from '../chat/outbox.js';
import { Icon, TopBar } from '../components/ui.js';
import { lastSeenPhrase } from '../lib/format.js';
import type { Message } from '../lib/types.js';
import { useHasOlder, useMessages, usePending, usePresence, useRealtime, useTyping } from '../realtime/hooks.js';
import { namer, systemText, useConversation } from '../queries.js';
import { useMe } from '../session.js';
import { BackLink } from './Shell.js';

export function Chat() {
  const { id = '' } = useParams();
  // A fresh view per conversation: divider, anchoring and edit state all reset.
  return <ChatView key={id} id={id} />;
}

function ChatView({ id }: { id: string }) {
  const me = useMe();
  const meId = me.data?.id ?? '';
  const rt = useRealtime();
  const conv = useConversation(id);
  const stored = useMessages(id);
  const pending = usePending(id);
  const hasOlder = useHasOlder(id);
  const typing = useTyping(id);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Message | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const list = useRef<MessageListHandle>(null);

  useEffect(() => {
    void rt.engine.loadLatest(id).then(() => { setLoaded(true); });
  }, [rt, id]);

  const c = conv.data;
  const mine = c?.members.find((m) => m.userId === meId);
  const peer = c?.kind === 'direct' ? c.members.find((m) => m.userId !== meId) : undefined;
  const presence = usePresence(peer?.userId);
  // The divider sits at my read marker as it was when I opened the conversation.
  const [initialReadSeq, setInitialReadSeq] = useState<number | null>(null);
  if (initialReadSeq === null && mine) setInitialReadSeq(mine.lastReadSeq);

  const nameOf = useMemo(() => namer(c?.members, meId), [c?.members, meId]);
  const items = useMemo(() => timeline(stored, pending, meId), [stored, pending, meId]);
  const name = c?.kind === 'group' ? (c.title ?? 'Group') : (peer?.displayName ?? '…');
  const typingNames = typing.filter((u) => u !== meId).map((u) => nameOf(u));
  const subtitle = typingNames.length > 0
    ? (c?.kind === 'group' ? `${typingNames.join(', ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…` : 'typing…')
    : c?.kind === 'group' ? `${String(c.members.filter((m) => m.active).length)} members` : lastSeenPhrase(presence);

  const act = (p: Promise<void>) => {
    setActionError(null);
    p.catch(() => { setActionError('That did not go through. Check your connection and try again.'); });
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={`Conversation with ${name}`}>
      <TopBar title={name}
        subtitle={<span aria-live="polite">{subtitle}</span>}
        back={<BackLink />}
        actions={
          <Link to={`/c/${id}/info`} aria-label="Conversation info" title="Conversation info"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-paper-deep"><Icon.Info /></Link>
        } />
      {actionError && <p role="alert" className="bg-paper-deep px-4 py-2 text-sm text-stamp">{actionError}</p>}
      {loaded && c && mine && initialReadSeq !== null ? (
        <MessageList ref={list} conversationId={id} kind={c.kind} meId={meId} items={items} members={c.members}
          initialReadSeq={initialReadSeq} myReadSeq={mine.lastReadSeq} hasOlder={hasOlder}
          loadOlder={() => rt.engine.loadOlder(id)}
          nameOf={nameOf} systemText={(m) => systemText(m.meta, nameOf)}
          onMarkRead={(seq) => { void rt.markRead(id, seq); }}
          onEdit={(m) => { setEditing(m); }}
          onDelete={(m) => { act(rt.deleteForEveryone(id, m.id)); }}
          onRetry={(p) => { void rt.retry(p.clientMsgId); }} />
      ) : (
        <p className="flex-1 p-6 text-center text-sm text-ink-soft">{conv.isError ? 'Could not open this conversation.' : 'Unfolding the letter…'}</p>
      )}
      <Composer key={editing?.id ?? 'new'}
        disabled={!c?.myRole || c.block !== null}
        disabledReason={!c ? 'Loading…'
          : !c.myRole ? 'You left this group. You can read it, but not write.'
          : c.block === 'by_me' ? 'You blocked this person. Unblock them in contact info to send messages.'
          : "You can't message this person."}
        editing={editing ? { body: editing.body ?? '' } : null}
        onSend={(body) => { void rt.send(id, body); requestAnimationFrame(() => list.current?.scrollToBottom()); }}
        onSaveEdit={(body) => { if (editing) act(rt.edit(id, editing.id, body)); setEditing(null); }}
        onCancelEdit={() => { setEditing(null); }}
        onTyping={(t) => { rt.sendTyping(id, t); }} />
    </section>
  );
}
