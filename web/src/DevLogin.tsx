import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api, ApiError } from './lib/api.js';

type User = { id: string; handle: string };

/** Signed-in state plus the development sign-in shortcut. Only works when the API has DEV_LOGIN=true. */
export function DevLogin() {
  const qc = useQueryClient();
  const [handle, setHandle] = useState('');
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api<{ user: User }>('/me')).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
  const login = useMutation({
    mutationFn: (h: string) => api<{ user: User }>('/dev/login', { method: 'POST', body: { handle: h } }),
    onSuccess: ({ user }) => { qc.setQueryData(['me'], user); setHandle(''); },
  });
  const logout = useMutation({
    mutationFn: () => api<undefined>('/dev/logout', { method: 'POST' }),
    onSuccess: () => { qc.setQueryData(['me'], null); },
  });

  if (me.isPending) return null;
  if (me.data) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span>Signed in as <strong>@{me.data.handle}</strong></span>
        <button type="button" className="rounded border border-ink/20 px-2 py-1 hover:bg-paper-deep" onClick={() => { logout.mutate(); }}>
          Sign out
        </button>
      </div>
    );
  }

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    login.mutate(handle);
  };
  const error = login.error instanceof ApiError && login.error.status === 404 ? 'Dev sign-in is disabled on this API.' : login.error?.message;

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2 text-sm" aria-label="Development sign-in">
      <label htmlFor="handle" className="text-ink-soft">Dev sign-in as</label>
      <input
        id="handle"
        value={handle}
        onChange={(e) => { setHandle(e.target.value); }}
        placeholder="handle"
        autoComplete="off"
        className="rounded border border-ink/20 bg-white px-2 py-1 focus:outline-2 focus:outline-ink"
      />
      <button type="submit" disabled={login.isPending} className="rounded bg-ink px-3 py-1 text-paper disabled:opacity-60">
        Sign in
      </button>
      {error && <p role="alert" className="w-full text-stamp">{error}</p>}
    </form>
  );
}
