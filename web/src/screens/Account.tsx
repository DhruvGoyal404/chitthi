import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, TopBar } from '../components/ui.js';
import { buttonClass } from '../components/styles.js';
import { api } from '../lib/api.js';
import { linkError, PROVIDERS, providerName } from '../lib/authErrors.js';
import type { BlockedUser, Identity } from '../lib/types.js';
import { useProviders, useSignOut } from '../session.js';
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
      </div>
    </section>
  );
}
