import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Icon } from '../components/ui.js';
import { buttonClass } from '../components/styles.js';
import { api, ApiError } from '../lib/api.js';
import { PROVIDERS, providerName, signInError } from '../lib/authErrors.js';
import type { Me } from '../lib/types.js';
import { useProviders } from '../session.js';

/** The development shortcut: any handle, no password. Shown only when the API has DEV_LOGIN on. */
function DevSignIn() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [handle, setHandle] = useState('');
  const login = useMutation({
    mutationFn: (h: string) => api<{ user: { id: string; handle: string } }>('/dev/login', { method: 'POST', body: { handle: h } }),
    onSuccess: async () => {
      const { user } = await api<{ user: Me }>('/me');
      qc.setQueryData(['me'], user);
      void navigate('/', { replace: true });
    },
  });
  const error = login.error instanceof ApiError
    ? (login.error.status === 429 ? 'Too many attempts. Wait a minute, then try again.' : login.error.message)
    : login.error ? 'Could not reach Chitthi. Try again.' : undefined;

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    login.mutate(handle.trim());
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Development sign-in">
      <Field id="handle" label="Development sign-in: your handle" value={handle} autoComplete="username" autoCapitalize="none" spellCheck={false}
        hint="3–20 letters, digits or _. No password: development servers only."
        onChange={(e) => { setHandle(e.target.value); }} error={error} required />
      <Button type="submit" variant="ghost" className="w-full" disabled={login.isPending || handle.trim().length < 3}>
        {login.isPending ? 'Signing in…' : 'Sign in with a handle'}
      </Button>
    </form>
  );
}

export function SignIn() {
  const [params] = useSearchParams();
  const providers = useProviders();
  const error = signInError(params.get('error'), params.get('provider'));
  const deleted = params.get('deleted') === '1';
  const offered = PROVIDERS.filter((p) => providers.data?.[p]);

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="letter rounded-sm p-6 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <span aria-hidden className="inline-flex h-12 w-10 items-center justify-center rounded-[3px] border-2 border-dashed border-stamp text-stamp">
              <Icon.Letter />
            </span>
            <div>
              <h1 className="font-[family-name:var(--font-letter)] text-2xl text-ink">Chitthi</h1>
              <p className="text-sm text-ink-soft">Letters that arrive in order.</p>
            </div>
          </div>
          {deleted && <p role="status" className="mb-4 rounded-md border border-paper-edge p-3 text-sm text-ink">Your account was deleted. Thank you for writing with Chitthi.</p>}
          {error && <p role="alert" className="mb-4 rounded-md border border-stamp p-3 text-sm text-ink">{error}</p>}
          {providers.isError && <p role="alert" className="mb-4 text-sm text-ink">Could not reach Chitthi. Try again.</p>}
          {offered.length > 0 && (
            <div className="space-y-3">
              {offered.map((p) => (
                // A full-page navigation: the API redirects to the provider and back.
                <a key={p} href={`/api/auth/${p}/start?next=/`} className={buttonClass('primary', 'w-full')}>
                  Continue with {providerName(p)}
                </a>
              ))}
              <p className="text-xs text-ink-soft">
                We get your name, verified email and picture. Nothing is posted anywhere.
              </p>
            </div>
          )}
          {providers.data?.dev && (
            <div className={offered.length > 0 ? 'mt-6 border-t border-dashed border-paper-edge pt-6' : ''}>
              <DevSignIn />
            </div>
          )}
          {providers.data && offered.length === 0 && !providers.data.dev && (
            <p className="text-sm text-ink">Sign-in is not set up on this server yet.</p>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-ink-soft">
          Not end-to-end encrypted: the server can read your messages.
        </p>
        <p className="mt-2 text-center text-xs text-ink-soft">
          <Link to="/privacy" className="underline underline-offset-2">Privacy</Link>
          {' · '}
          <Link to="/terms" className="underline underline-offset-2">Terms</Link>
        </p>
      </div>
    </main>
  );
}
