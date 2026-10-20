import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Field, IconButton, Icon, TopBar } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import type { User } from '../lib/types.js';
import { MemberPicker } from './MemberPicker.js';
import { BackLink } from './Shell.js';

export function NewGroup() {
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<User[]>([]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api<{ conversation: { id: string } }>('/conversations', {
      method: 'POST', body: { title: title.trim(), memberIds: members.map((m) => m.id) },
    }),
    onSuccess: ({ conversation }) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void navigate(`/c/${conversation.id}`, { replace: true });
    },
  });
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="New group">
      <TopBar title="New group" back={<BackLink to="/new" />} />
      <form onSubmit={onSubmit} className="space-y-5 overflow-y-auto p-4">
        <Field id="title" label="Group name" value={title} maxLength={80} required onChange={(e) => { setTitle(e.target.value); }} />
        <MemberPicker exclude={new Set(members.map((m) => m.id))} onPick={(u) => { setMembers((ms) => [...ms, u]); }} />
        {members.length > 0 && (
          <div>
            <h2 className="mb-2 text-sm font-medium text-ink">Members ({members.length})</h2>
            <ul className="flex flex-wrap gap-2">
              {members.map((m) => (
                <li key={m.id} className="inline-flex items-center gap-1 rounded-full border border-paper-edge bg-sheet py-0.5 pl-3 text-sm text-ink">
                  {m.displayName}
                  <IconButton label={`Remove ${m.displayName}`} className="h-8 w-8" onClick={() => { setMembers((ms) => ms.filter((x) => x.id !== m.id)); }}>
                    <Icon.Close width={16} height={16} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </div>
        )}
        {create.isError && (
          <p role="alert" className="text-sm text-stamp">{create.error instanceof ApiError ? create.error.message : 'Could not create the group.'}</p>
        )}
        <Button type="submit" disabled={create.isPending || title.trim().length === 0}>Create group</Button>
      </form>
    </section>
  );
}
