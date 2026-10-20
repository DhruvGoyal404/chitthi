import { useEffect, useState, type SubmitEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Avatar, Button, Icon, TopBar } from '../components/ui.js';
import { api } from '../lib/api.js';
import { clock, lastSeenPhrase } from '../lib/format.js';
import type { Message } from '../lib/types.js';
import { uuidv7 } from '../lib/uuid.js';
import { useMessages, usePresence, useRealtime } from '../realtime/hooks.js';
import { namer, systemText, useConversation } from '../queries.js';
import { useMe } from '../session.js';
import { BackLink } from './Shell.js';

/** Basic chat view (the full one — virtualized, optimistic, ticks — replaces this in the chat piece). */
export function Chat() {
  const { id = '' } = useParams();
  const me = useMe();
  const rt = useRealtime();
  const conv = useConversation(id);
  const messages = useMessages(id);
  const peer = conv.data?.kind === 'direct' ? conv.data.members.find((m) => m.userId !== me.data?.id) : undefined;
  const presence = usePresence(peer?.userId);
  const [draft, setDraft] = useState('');

  useEffect(() => { void rt.engine.loadLatest(id); }, [rt, id]);

  const name = conv.data?.kind === 'group' ? (conv.data.title ?? 'Group') : (peer?.displayName ?? '…');
  const nameOf = namer(conv.data?.members, me.data?.id);
  const onSubmit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = draft;
    setDraft('');
    const { message } = await api<{ message: Message }>(`/conversations/${id}/messages`, { method: 'POST', body: { clientMsgId: uuidv7(), body } });
    await rt.ack(message);
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={`Conversation with ${name}`}>
      <TopBar title={name} subtitle={lastSeenPhrase(presence)} back={<BackLink />}
        actions={<Link to={`/c/${id}/info`} aria-label="Conversation info" className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-paper-deep"><Icon.Info /></Link>} />
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {messages.map((m) => (
          <li key={m.id} className={m.kind === 'system' ? 'text-center text-xs text-ink-soft' : m.senderId === me.data?.id ? 'flex justify-end' : 'flex'}>
            {m.kind === 'system' ? systemText(m.meta, nameOf) : (
              <div className={`letter max-w-[80%] rounded-sm px-3 py-2 shadow-sm ${m.senderId === me.data?.id ? 'mine' : ''}`}>
                {conv.data?.kind === 'group' && m.senderId !== me.data?.id && <p className="text-xs font-semibold text-seal">{nameOf(m.senderId)}</p>}
                <p className="whitespace-pre-wrap break-words text-ink">{m.body ?? <em className="text-ink-soft">message deleted</em>}</p>
                <p className="text-right text-[0.7rem] text-ink-soft">{clock(m.createdAt)}</p>
              </div>
            )}
          </li>
        ))}
      </ol>
      <form onSubmit={(e) => { void onSubmit(e); }} className="flex gap-2 border-t border-paper-edge bg-paper-deep p-2">
        <label htmlFor="composer" className="sr-only">Message</label>
        <input id="composer" value={draft} onChange={(e) => { setDraft(e.target.value); }} className="min-h-11 flex-1 rounded-md border border-paper-edge bg-sheet px-3 text-ink" placeholder="Write a letter…" />
        <Button type="submit" disabled={draft.trim() === ''} aria-label="Send"><Icon.Send /></Button>
      </form>
      <span hidden><Avatar name={name} /></span>
    </section>
  );
}
