import { useConnection } from '../realtime/hooks.js';

/**
 * Live / reconnecting / offline. Silent while live; a polite status strip otherwise. While offline,
 * sends fail fast and are resent automatically (same client message id) once the socket is back.
 */
export function ConnectionBanner() {
  const state = useConnection();
  const text = state === 'offline'
    ? "You're offline. Letters you write will be sent when you're back."
    : state === 'reconnecting'
      ? 'Reconnecting… new letters will catch up.'
      : null;
  return (
    <div role="status" data-connection={state} className={text ? 'shrink-0 border-b border-dashed border-stamp bg-paper-deep px-4 py-1.5 text-center text-sm text-ink' : 'sr-only'}>
      {text ?? (state === 'live' ? 'Connected' : '')}
    </div>
  );
}
