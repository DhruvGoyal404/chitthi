import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar, Button, Field, TopBar } from '../components/ui.js';
import { buttonClass } from '../components/styles.js';
import { api, ApiError } from '../lib/api.js';
import type { User } from '../lib/types.js';
import { useMe, useSignOut } from '../session.js';
import { useTheme, type ThemeChoice } from '../theme.js';
import { BackLink } from './Shell.js';

export function Settings() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const [theme, setTheme] = useTheme();
  const [displayName, setDisplayName] = useState(me.data?.displayName ?? '');
  const [handle, setHandle] = useState(me.data?.handle ?? '');
  const save = useMutation({
    mutationFn: () => api<{ user: User }>('/me', {
      method: 'PATCH',
      body: {
        ...(displayName.trim() !== me.data?.displayName && { displayName: displayName.trim() }),
        ...(handle.trim() !== me.data?.handle && { handle: handle.trim() }),
      },
    }),
    onSuccess: ({ user }) => {
      qc.setQueryData(['me'], user);
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const unchanged = displayName.trim() === me.data?.displayName && handle.trim() === me.data.handle;
  const fieldError = (code: string) => (save.error instanceof ApiError && save.error.code === code ? save.error.message : undefined);

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Settings">
      <TopBar title="Settings" back={<BackLink />} />
      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-4">
        <form onSubmit={onSubmit} className="space-y-4" aria-label="Profile">
          <div className="flex items-center gap-3">
            <Avatar name={me.data?.displayName ?? ''} src={me.data?.avatarUrl} size={48} />
            <h2 className="text-sm font-medium text-ink-soft">Profile</h2>
          </div>
          <Field id="display-name" label="Display name" value={displayName} maxLength={60} required
            onChange={(e) => { setDisplayName(e.target.value); }} />
          <Field id="handle" label="Handle" value={handle} autoCapitalize="none" spellCheck={false}
            hint="3–20 letters, digits or _. Unique, ignoring case."
            error={fieldError('handle_taken') ?? fieldError('handle_reserved') ?? fieldError('invalid_request')}
            onChange={(e) => { setHandle(e.target.value); }} />
          {save.isSuccess && unchanged && <p role="status" className="text-sm text-ink-soft">Saved.</p>}
          <Button type="submit" disabled={save.isPending || unchanged}>Save</Button>
        </form>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-soft">Appearance</legend>
          {(['system', 'light', 'dark'] as ThemeChoice[]).map((t) => (
            <label key={t} className="flex min-h-11 items-center gap-3 text-ink">
              <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => { setTheme(t); }} className="h-4 w-4 accent-[var(--seal)]" />
              {t === 'system' ? 'Match my device' : t === 'light' ? 'Light (day letter)' : 'Dark (night letter)'}
            </label>
          ))}
        </fieldset>

        <div className="space-y-2">
          <Link to="/account" className={buttonClass('ghost')}>Account and sign-in</Link>
          <p className="text-sm text-ink-soft">Messages are not end-to-end encrypted: the server can read them.</p>
          <p className="text-sm text-ink-soft">Deleted messages and files stay in encrypted backups for up to 12 weeks.</p>
          <p className="text-sm text-ink-soft">
            <Link to="/privacy" className="underline underline-offset-2">Privacy</Link>
            {' · '}
            <Link to="/terms" className="underline underline-offset-2">Terms</Link>
          </p>
          <Button variant="ghost" onClick={() => { signOut.mutate(undefined, { onSettled: () => { void navigate('/signin', { replace: true }); } }); }}>
            Sign out
          </Button>
        </div>
      </div>
    </section>
  );
}
