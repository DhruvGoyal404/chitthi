import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar, Button, Field } from '../components/ui.js';
import { buttonClass } from '../components/styles.js';
import { api, ApiError } from '../lib/api.js';
import { providerName } from '../lib/authErrors.js';
import type { Me, Provider } from '../lib/types.js';

type Pending = { provider: Provider; email: string; displayName: string; avatarUrl: string | null; suggestedHandle: string };

function WelcomeForm({ pending }: { pending: Pending }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [handle, setHandle] = useState(pending.suggestedHandle);
  const [displayName, setDisplayName] = useState(pending.displayName);
  const create = useMutation({
    mutationFn: () => api<{ user: Me }>('/auth/onboarding', { method: 'POST', body: { handle: handle.trim(), displayName: displayName.trim() } }),
    onSuccess: ({ user }) => {
      qc.setQueryData(['me'], user);
      void navigate('/', { replace: true });
    },
  });
  const err = create.error instanceof ApiError ? create.error : undefined;
  const handleError = err && ['handle_taken', 'handle_reserved', 'invalid_handle', 'invalid_request'].includes(err.code) ? err.message : undefined;
  const otherError = create.error && !handleError
    ? (err?.code === 'signup_expired' ? 'This sign-in expired. Please start again from the sign-in page.' : err?.message ?? 'Could not reach Chitthi. Try again.')
    : undefined;

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Create your account">
      <div className="flex items-center gap-3">
        <Avatar name={displayName || pending.displayName} src={pending.avatarUrl} size={56} />
        <p className="text-sm text-ink-soft">
          Signed in with {providerName(pending.provider)} as <span className="break-all text-ink">{pending.email}</span>.
        </p>
      </div>
      <Field id="handle" label="Pick a handle" value={handle} autoCapitalize="none" spellCheck={false} required
        hint="How people find you. 3–20 letters, digits or _, unique ignoring case." error={handleError}
        onChange={(e) => { setHandle(e.target.value); }} />
      <Field id="display-name" label="Display name" value={displayName} maxLength={60} required
        onChange={(e) => { setDisplayName(e.target.value); }} />
      {otherError && <p role="alert" className="text-sm text-stamp">{otherError}</p>}
      <Button type="submit" className="w-full" disabled={create.isPending || handle.trim().length < 3 || !displayName.trim()}>
        {create.isPending ? 'Creating…' : 'Create account'}
      </Button>
    </form>
  );
}

/** First sign-in: pick a handle; the name and picture come prefilled from the provider. */
export function Welcome() {
  const pending = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api<Pending>('/auth/onboarding'),
    retry: false,
    staleTime: Infinity,
  });
  const expired = pending.error instanceof ApiError && pending.error.status === 404;

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="letter w-full max-w-sm rounded-sm p-6 shadow-sm">
        <h1 className="mb-4 font-[family-name:var(--font-letter)] text-2xl text-ink">Welcome to Chitthi</h1>
        {pending.data && <WelcomeForm pending={pending.data} />}
        {pending.isPending && <p className="text-sm text-ink-soft">Loading…</p>}
        {pending.isError && (
          <div className="space-y-4">
            <p role="alert" className="text-sm text-ink">
              {expired ? 'This sign-in expired or was already used. Please start again.' : 'Could not reach Chitthi. Try again.'}
            </p>
            <Link to="/signin" className={buttonClass('ghost')}>Back to sign-in</Link>
          </div>
        )}
      </div>
    </main>
  );
}
