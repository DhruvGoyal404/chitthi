import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Avatar, Button, Icon, IconButton, PresenceDot, TopBar } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import { lastSeenPhrase } from '../lib/format.js';
import type { Member, User } from '../lib/types.js';
import { usePresence } from '../realtime/hooks.js';
import { useConversation } from '../queries.js';
import { useMe } from '../session.js';
import { MemberPicker } from './MemberPicker.js';
import { BackLink } from './Shell.js';

function MemberRow({ m, meId, canRemove, onRemove }: { m: Member; meId: string | undefined; canRemove: boolean; onRemove: () => void }) {
  const presence = usePresence(m.userId);
  const seen = m.userId === meId ? null : lastSeenPhrase(presence);
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="relative">
        <Avatar name={m.displayName} src={m.avatarUrl} size={36} />
        {presence && <PresenceDot online={presence.online} className="absolute -bottom-0.5 -right-0.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">
          {m.userId === meId ? 'You' : m.displayName}
          {m.role !== 'member' && <span className="ml-2 rounded border border-paper-edge px-1 text-xs font-normal text-ink-soft">{m.role}</span>}
        </span>
        <span className="block truncate text-sm text-ink-soft">@{m.handle}{seen && ` · ${seen}`}</span>
      </span>
      {canRemove && (
        <IconButton label={`Remove ${m.displayName}`} onClick={onRemove}><Icon.Close /></IconButton>
      )}
    </li>
  );
}

/**
 * Block or unblock the other person of a DM. Blocking asks first and says what it does and
 * doesn't do (shared groups are unchanged; docs/AUTH.md explains why).
 */
function BlockControl({ conversationId, peer, blocked }: { conversationId: string; peer: Member; blocked: boolean }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const change = useMutation({
    mutationFn: (block: boolean) => api(`/blocks/${peer.userId}`, { method: block ? 'PUT' : 'DELETE' }),
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void qc.invalidateQueries({ queryKey: ['blocks'] });
    },
  });
  if (blocked) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-ink">You blocked {peer.displayName}.</p>
        <Button variant="ghost" disabled={change.isPending} onClick={() => { change.mutate(false); }}>Unblock {peer.displayName}</Button>
      </div>
    );
  }
  if (!confirming) {
    return <Button variant="danger" onClick={() => { setConfirming(true); }}>Block {peer.displayName}</Button>;
  }
  return (
    <div className="space-y-3 rounded-md border border-stamp p-3" role="group" aria-label={`Block ${peer.displayName}?`}>
      <p className="text-sm text-ink">
        Block {peer.displayName}? Neither of you can message the other here, they can't start a chat with you or add you
        to groups, and you stop seeing each other's online status and typing. Groups you already share stay as they are.
      </p>
      <div className="flex gap-2">
        <Button variant="danger" disabled={change.isPending} onClick={() => { change.mutate(true); }}>Block</Button>
        <Button variant="ghost" onClick={() => { setConfirming(false); }}>Cancel</Button>
      </div>
      {change.isError && <p role="alert" className="text-sm text-stamp">{change.error instanceof ApiError ? change.error.message : 'Could not block. Try again.'}</p>}
    </div>
  );
}

/** Members (with presence), adding/removing for owners and admins, and leaving. */
export function ConversationInfo() {
  const { id = '' } = useParams();
  const me = useMe();
  const conv = useConversation(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['conversation', id] });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
  };
  const add = useMutation({ mutationFn: (u: User) => api(`/conversations/${id}/members`, { method: 'POST', body: { userId: u.id } }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (userId: string) => api(`/conversations/${id}/members/${userId}`, { method: 'DELETE' }), onSuccess: refresh });
  const leave = useMutation({
    mutationFn: () => api(`/conversations/${id}/leave`, { method: 'POST' }),
    onSuccess: () => { refresh(); void navigate(`/c/${id}`); },
  });

  const c = conv.data;
  const active = c?.members.filter((m) => m.active) ?? [];
  const former = c?.members.filter((m) => !m.active) ?? [];
  const canManage = c?.kind === 'group' && (c.myRole === 'owner' || c.myRole === 'admin');
  const error = [add.error, remove.error, leave.error].find(Boolean);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Conversation info">
      <TopBar title={c?.kind === 'group' ? (c.title ?? 'Group') : 'Contact info'} subtitle={c?.kind === 'group' ? `${String(active.length)} members` : undefined}
        back={<BackLink to={`/c/${id}`} />} />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {error && <p role="alert" className="text-sm text-stamp">{error instanceof ApiError ? error.message : 'Something went wrong.'}</p>}
        <div>
          <h2 className="text-sm font-medium text-ink-soft">Members</h2>
          <ul className="divide-y divide-paper-edge">
            {active.map((m) => (
              <MemberRow key={m.userId} m={m} meId={me.data?.id}
                canRemove={canManage && m.userId !== me.data?.id && m.role !== 'owner' && (m.role !== 'admin' || c.myRole === 'owner')}
                onRemove={() => { remove.mutate(m.userId); }} />
            ))}
          </ul>
        </div>
        {canManage && <MemberPicker exclude={new Set(active.map((m) => m.userId))} onPick={(u) => { add.mutate(u); }} />}
        {former.length > 0 && (
          <div>
            <h2 className="text-sm font-medium text-ink-soft">Former members</h2>
            <ul className="text-sm text-ink-soft">{former.map((m) => <li key={m.userId} className="py-1">{m.displayName} @{m.handle}</li>)}</ul>
          </div>
        )}
        {c?.kind === 'direct' && (() => {
          const peer = c.members.find((m) => m.userId !== me.data?.id);
          if (peer?.deleted) return <p className="text-sm text-ink-soft">This account was deleted.</p>;
          return peer && <BlockControl conversationId={id} peer={peer} blocked={c.block === 'by_me'} />;
        })()}
        {c?.kind === 'group' && c.myRole && (
          <Button variant="danger" onClick={() => { leave.mutate(); }} disabled={leave.isPending}>Leave group</Button>
        )}
        {c?.kind === 'group' && !c.myRole && <p className="text-sm text-ink-soft">You left this group. You can still read it up to when you left.</p>}
      </div>
    </section>
  );
}
