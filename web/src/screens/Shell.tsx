import { Link, Navigate, Outlet, useMatch } from 'react-router';
import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { Icon } from '../components/ui.js';
import { RealtimeProvider } from '../realtime/RealtimeProvider.js';
import { useMe } from '../session.js';
import { Inbox } from './Inbox.js';

/** Back to the inbox (mobile only), or to a specific screen (always). */
export function BackLink({ to }: { to?: string }) {
  return (
    <Link to={to ?? '/'} aria-label="Back" title="Back"
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-paper-deep ${to ? '' : 'md:hidden'}`}>
      <Icon.Back />
    </Link>
  );
}

function EmptyPane() {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-ink-soft">
      <span aria-hidden className="inline-flex h-16 w-14 items-center justify-center rounded-[3px] border-2 border-dashed border-paper-edge">
        <Icon.Letter width={28} height={28} />
      </span>
      <p className="font-[family-name:var(--font-letter)] text-lg text-ink">Pick a letter to read</p>
      <p className="max-w-xs text-sm">Choose a conversation, or start a new one with the + button.</p>
    </div>
  );
}

/**
 * Mobile-first: one screen at a time. From md up, two panes: the inbox stays on the left and every
 * other screen opens on the right.
 */
function Layout() {
  const atInbox = useMatch('/') !== null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1">
      <nav aria-label="Conversations" className={`${atInbox ? 'flex' : 'hidden'} min-h-0 w-full flex-col border-paper-edge md:flex md:w-[22rem] md:shrink-0 md:border-r`}>
        <Inbox />
      </nav>
      <main className={`${atInbox ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col md:flex`}>
        {atInbox ? <EmptyPane /> : <Outlet />}
      </main>
      </div>
    </div>
  );
}

/** Signed-in area: requires a session, and owns the realtime connection. */
export function Shell() {
  const me = useMe();
  if (me.isPending) return <p className="p-6 text-ink-soft">Opening Chitthi…</p>;
  if (me.isError) return <p role="alert" className="p-6 text-stamp">Could not reach Chitthi. Reload to try again.</p>;
  if (!me.data) return <Navigate to="/signin" replace />;
  return (
    <RealtimeProvider key={me.data.id}>
      <Layout />
    </RealtimeProvider>
  );
}
