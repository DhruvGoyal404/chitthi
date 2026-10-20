import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar, Field, Icon, TopBar } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import type { User } from '../lib/types.js';
import { useUserSearch } from '../queries.js';
import { BackLink } from './Shell.js';

/** Start a DM by handle (prefix search), or go to group creation. */
export function NewChat() {
  const [q, setQ] = useState('');
  const results = useUserSearch(q);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: (u: User) => api<{ conversation: { id: string } }>('/conversations/direct', { method: 'POST', body: { userId: u.id } }),
    onSuccess: ({ conversation }) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void navigate(`/c/${conversation.id}`);
    },
  });

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="New conversation">
      <TopBar title="New conversation" back={<BackLink />} />
      <div className="space-y-4 overflow-y-auto p-4">
        <Link to="/new/group" className="flex items-center gap-3 rounded-md border border-paper-edge bg-sheet p-3 hover:bg-paper-deep">
          <Avatar name="" group size={36} />
          <span className="font-medium text-ink">New group</span>
        </Link>
        <Field id="search" label="Find someone by handle" type="search" value={q} autoComplete="off" autoCapitalize="none" spellCheck={false}
          hint="Type at least 3 characters of their handle." onChange={(e) => { setQ(e.target.value); }} />
        <div aria-live="polite">
          {results.isFetching && <p className="text-sm text-ink-soft">Searching…</p>}
          {results.data?.length === 0 && <p className="text-sm text-ink-soft">Nobody with a handle starting “{q.trim()}”.</p>}
          {results.data?.length === 8 && <p className="text-sm text-ink-soft">Showing the first 8. Type more of the handle to narrow it down.</p>}
          {results.isError && <p role="alert" className="text-sm text-stamp">{results.error instanceof ApiError ? results.error.message : 'Search failed. Try again.'}</p>}
        </div>
        {start.isError && <p role="alert" className="text-sm text-stamp">{start.error instanceof ApiError ? start.error.message : 'Could not start the conversation.'}</p>}
        <ul className="space-y-1">
          {results.data?.map((u) => (
            <li key={u.id}>
              <button type="button" onClick={() => { start.mutate(u); }} disabled={start.isPending}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-paper-deep">
                <Avatar name={u.displayName} size={36} />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{u.displayName}</span>
                  <span className="block truncate text-sm text-ink-soft">@{u.handle}</span>
                </span>
                <Icon.Send className="ml-auto text-ink-soft" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
