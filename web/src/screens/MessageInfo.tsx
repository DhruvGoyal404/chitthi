import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { Linkified } from '../chat/Linkified.js';
import { Avatar, TopBar } from '../components/ui.js';
import { api } from '../lib/api.js';
import { fullWhen } from '../lib/format.js';
import { useMessages } from '../realtime/hooks.js';
import { BackLink } from './Shell.js';

type Receipt = { userId: string; handle: string; displayName: string; deliveredAt: string | null; readAt: string | null };

function Section({ title, people, when }: { title: string; people: Receipt[]; when: (r: Receipt) => string | null }) {
  if (people.length === 0) return null;
  return (
    <section aria-label={title}>
      <h2 className="mb-1 text-sm font-medium text-ink-soft">{title}</h2>
      <ul className="divide-y divide-paper-edge">
        {people.map((r) => {
          const t = when(r);
          return (
            <li key={r.userId} className="flex items-center gap-3 py-2">
              <Avatar name={r.displayName} size={32} />
              <span className="min-w-0 flex-1 truncate text-ink">{r.displayName}</span>
              {t && <time dateTime={t} className="text-xs text-ink-soft">{fullWhen(t)}</time>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Group message info: who has read it, who has received it, who hasn't yet, and when. */
export function MessageInfo() {
  const { id = '', messageId = '' } = useParams();
  const message = useMessages(id).find((m) => m.id === messageId);
  const receipts = useQuery({
    queryKey: ['receipts', id, messageId],
    queryFn: async () => (await api<{ receipts: Receipt[] }>(`/conversations/${id}/messages/${messageId}/receipts`)).receipts,
  });
  const all = receipts.data ?? [];
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Message info">
      <TopBar title="Message info" back={<BackLink to={`/c/${id}`} />} />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {message && (
          <div className="letter mine rounded-sm px-3 py-2 shadow-sm">
            <p className="whitespace-pre-wrap break-words font-[family-name:var(--font-letter)] text-ink">
              {message.deletedAt ? <em className="text-ink-soft">message deleted</em> : <Linkified text={message.body ?? ''} />}
            </p>
          </div>
        )}
        {receipts.isError && <p role="alert" className="text-sm text-stamp">Could not load who read this.</p>}
        <Section title="Read by" people={all.filter((r) => r.readAt)} when={(r) => r.readAt} />
        <Section title="Delivered to" people={all.filter((r) => !r.readAt && r.deliveredAt)} when={(r) => r.deliveredAt} />
        <Section title="Not yet delivered" people={all.filter((r) => !r.deliveredAt)} when={() => null} />
      </div>
    </section>
  );
}
