import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Field, Icon } from '../components/ui.js';
import { api, ApiError } from '../lib/api.js';
import type { User } from '../lib/types.js';

/** Development sign-in: any handle, no password. Only works when the API runs with DEV_LOGIN=true. */
export function SignIn() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [handle, setHandle] = useState('');
  const login = useMutation({
    mutationFn: (h: string) => api<{ user: { id: string; handle: string } }>('/dev/login', { method: 'POST', body: { handle: h } }),
    onSuccess: async () => {
      const { user } = await api<{ user: User }>('/me');
      qc.setQueryData(['me'], user);
      void navigate('/', { replace: true });
    },
  });
  const error = login.error instanceof ApiError
    ? (login.error.status === 404 ? 'Dev sign-in is turned off on this server.' : login.error.message)
    : login.error ? 'Could not reach Chitthi. Try again.' : undefined;

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    login.mutate(handle.trim());
  };

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
          <form onSubmit={onSubmit} className="space-y-4" aria-label="Sign in">
            <Field id="handle" label="Your handle" value={handle} autoComplete="username" autoCapitalize="none" spellCheck={false}
              hint="3–20 letters, digits or _. Development sign-in: no password."
              onChange={(e) => { setHandle(e.target.value); }} error={error} required />
            <Button type="submit" className="w-full" disabled={login.isPending || handle.trim().length < 3}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>
        <p className="mt-4 text-center text-xs text-ink-soft">
          Not end-to-end encrypted: the server can read your messages.
        </p>
      </div>
    </main>
  );
}
