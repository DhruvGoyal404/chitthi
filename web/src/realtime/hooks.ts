import { useContext, useSyncExternalStore } from 'react';
import type { Pending } from '../chat/outbox.js';
import type { Message, PresenceEvent } from '../lib/types.js';
import type { ConnectionState, RealtimeClient } from './client.js';
import { RealtimeContext } from './context.js';

export function useRealtime(): RealtimeClient {
  const c = useContext(RealtimeContext);
  if (!c) throw new Error('useRealtime outside RealtimeProvider');
  return c;
}

export function useConnection(): ConnectionState {
  const c = useRealtime();
  return useSyncExternalStore(c.connection.subscribe, c.connection.get);
}

export function usePresence(userId: string | undefined): PresenceEvent | undefined {
  const c = useRealtime();
  const map = useSyncExternalStore(c.presence.subscribe, c.presence.get);
  return userId ? map.get(userId) : undefined;
}

const NOBODY: readonly string[] = [];

/** User ids currently typing in a conversation (the client expires entries on its own timer). */
export function useTyping(conversationId: string): readonly string[] {
  const c = useRealtime();
  const map = useSyncExternalStore(c.typing.subscribe, c.typing.get);
  const users = map.get(conversationId);
  return users && users.size > 0 ? [...users.keys()] : NOBODY;
}

/** The stored messages of a conversation, kept current by the sync engine. */
export function useMessages(conversationId: string): Message[] {
  const c = useRealtime();
  return useSyncExternalStore(
    (fn) => c.engine.subscribe((id) => { if (id === conversationId) fn(); }),
    () => c.engine.messages(conversationId),
  );
}

/** My unsent (pending/failed) messages in a conversation. */
export function usePending(conversationId: string): Pending[] {
  const c = useRealtime();
  return useSyncExternalStore(
    (fn) => c.outbox.subscribe((id) => { if (id === conversationId) fn(); }),
    () => c.outbox.list(conversationId),
  );
}

/** Whether older history exists above what is loaded. */
export function useHasOlder(conversationId: string): boolean {
  const c = useRealtime();
  return useSyncExternalStore(
    (fn) => c.engine.subscribe((id) => { if (id === conversationId) fn(); }),
    () => c.engine.get(conversationId)?.hasOlder ?? false,
  );
}
