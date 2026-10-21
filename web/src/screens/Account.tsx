import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, Field, TopBar } from '../components/ui.js';
import { buttonClass } from '../components/styles.js';
import { api, ApiError } from '../lib/api.js';
import { linkError, PROVIDERS, providerName } from '../lib/authErrors.js';
import type { BlockedUser, Identity } from '../lib/types.js';
import { useMe, useProviders, useSignOut } from '../session.js';
import { BackLink } from './Shell.js';

function SignInMethods() {
  const [params] = useSearchParams();
  const providers = useProviders();
  const identities = useQuery({ queryKey: ['identities'], queryFn: () => api<{ identities: Identity[] }>('/auth/identities') });
  const linked = params.get('linked');
  const error = linkError(params.get('error'), params.get('provider'));
  const offered = PROVIDERS.filter((p) => providers.data?.[p]);

  return (
    <section className="space-y-3" aria-labelledby="methods-h">
      <h2 id="methods-h" className="text-sm font-medium text-ink-soft">Sign-in methods</h2>
      {linked && <p role="status" className="text-sm text-ink">{providerName(linked)} is linked. You can now sign in with it.</p>}
      {error && <p role="alert" className="rounded-md border border-stamp p-3 text-sm text-ink">{error}</p>}
      <ul className="space-y-2">
        {offered.map((p) => {
          const id = identities.data?.identities.find((i) => i.provider === p);
          return (
            <li key={p} className="flex min-h-11 items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-ink">{providerName(p)}</p>
                <p className="truncate text-sm text-ink-soft">{id ? (id.email ?? 'Linked') : 'Not linked'}</p>
              </div>
              {/* Linking is always explicit and starts from here (a full-page trip to the provider). */}
              {!id && identities.isSuccess && (
                <a href={`/api/auth/${p}/link`} className={buttonClass('ghost')} aria-label={`Link ${providerName(p)}`}>Link</a>
              )}
            </li>
          );
        })}
      </ul>
      {offered.length === 0 && <p className="text-sm text-ink-soft">No sign-in providers are set up on this server.</p>}
      <p className="text-xs text-ink-soft">Accounts are never joined by email: link a provider here to sign in with it.</p>
    </section>
  );
}

function BlockedPeople() {
  const qc = useQueryClient();
  const blocked = useQuery({ queryKey: ['blocks'], queryFn: () => api<{ blocked: BlockedUser[] }>('/blocks') });
  const unblock = useMutation({
    mutationFn: (userId: string) => api(`/blocks/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['blocks'] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
    },
  });
  const list = blocked.data?.blocked ?? [];
  return (
    <section className="space-y-3" aria-labelledby="blocked-h">
      <h2 id="blocked-h" className="text-sm font-medium text-ink-soft">Blocked people</h2>
      {blocked.isSuccess && list.length === 0 && <p className="text-sm text-ink-soft">You haven't blocked anyone. You can block someone from their contact info.</p>}
      <ul className="space-y-2">
        {list.map((u) => (
          <li key={u.userId} className="flex min-h-11 items-center justify-between gap-3">
            <span className="min-w-0 truncate text-ink">{u.displayName} <span className="text-ink-soft">@{u.handle}</span></span>
            <Button variant="ghost" disabled={unblock.isPending} onClick={() => { unblock.mutate(u.userId); }}>Unblock<span className="sr-only"> {u.displayName}</span></Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Deleting the account: says exactly what happens, offers erasing messages, asks for the handle. */
function DeleteAccount() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [erase, setErase] = useState(false);
  const [confirm, setConfirm] = useState('');
  const remove = useMutation({
    mutationFn: () => api('/me', { method: 'DELETE', body: { confirmHandle: confirm.trim(), eraseMessages: erase } }),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(['me'], null);
      void navigate('/signin?deleted=1', { replace: true });
    },
  });
  const handle = me.data?.handle ?? '';
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    remove.mutate();
  };
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-stamp p-3" aria-labelledby="delete-h">
      <h2 id="delete-h" className="text-sm font-medium text-ink">Delete account</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
        <li>You are signed out everywhere, and your sign-in methods and blocks are removed.</li>
        <li>You leave every group. Groups you own pass to an admin, or else the longest-standing member.</li>
        <li>Your letters stay for the people you wrote to, signed "Deleted user". Chats with you take no new messages.</li>
        <li>Your handle stays unavailable to anyone else for 30 days.</li>
      </ul>
      <label className="flex min-h-11 items-start gap-3 text-sm text-ink">
        <input type="checkbox" checked={erase} onChange={(e) => { setErase(e.target.checked); }} className="mt-0.5 h-4 w-4 accent-[var(--seal)]" />
        <span>Also erase every message I sent. They will show as "message deleted" for everyone.</span>
      </label>
      <Field id="confirm-handle" label={`Type your handle (${handle}) to confirm`} value={confirm} autoComplete="off" autoCapitalize="none" spellCheck={false}
        error={remove.error ? (remove.error instanceof ApiError ? remove.error.message : 'Could not delete the account. Try again.') : undefined}
        onChange={(e) => { setConfirm(e.target.value); }} />
      <Button type="submit" variant="danger" disabled={remove.isPending || confirm.trim().toLowerCase() !== handle.toLowerCase() || !handle}>
        {remove.isPending ? 'Deleting…' : 'Delete my account'}
      </Button>
    </form>
  );
}

export function Account() {
  const navigate = useNavigate();
  const signOutEverywhere = useSignOut(true);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Account">
      <TopBar title="Account" back={<BackLink to="/settings" />} />
      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-4">
        <SignInMethods />
        <BlockedPeople />
        <section className="space-y-2" aria-labelledby="sessions-h">
          <h2 id="sessions-h" className="text-sm font-medium text-ink-soft">Sessions</h2>
          <p className="text-sm text-ink">Signs out every browser and device, including this one.</p>
          <Button variant="ghost" disabled={signOutEverywhere.isPending}
            onClick={() => { signOutEverywhere.mutate(undefined, { onSettled: () => { void navigate('/signin', { replace: true }); } }); }}>
            Sign out everywhere
          </Button>
        </section>
        <DeleteAccount />
      </div>
    </section>
  );
}
