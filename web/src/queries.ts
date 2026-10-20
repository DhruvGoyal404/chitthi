import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './lib/api.js';
import type { ConversationDetail, InboxEntry, Member, User } from './lib/types.js';

export function useConversations() {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: async () => (await api<{ conversations: InboxEntry[] }>('/conversations')).conversations,
  });
}

export function useConversation(id: string) {
  return useQuery({
    queryKey: ['conversation', id],
    queryFn: async () => (await api<{ conversation: ConversationDetail }>(`/conversations/${id}`)).conversation,
  });
}

export function useUserSearch(q: string) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['user-search', trimmed.toLowerCase()],
    queryFn: async () => (await api<{ users: User[] }>(`/users?q=${encodeURIComponent(trimmed)}`)).users,
    // The API needs 3+ characters and caps answers at 8 (anti-enumeration). A 4xx (e.g. 429)
    // is not retried: retrying would only spend more of the search budget.
    enabled: /^[A-Za-z0-9_]{3,20}$/.test(trimmed),
    staleTime: 30_000,
    retry: (failures, e) => !(e instanceof ApiError && e.status < 500) && failures < 2,
  });
}

/** How a system message reads, given who is who. */
export function systemText(meta: Record<string, unknown> | null, nameOf: (id: unknown) => string): string {
  switch (meta?.event) {
    case 'group_created': return `${nameOf(meta.actor)} created the group`;
    case 'member_added': return `${nameOf(meta.actor)} added ${nameOf(meta.target)}`;
    case 'member_removed': return `${nameOf(meta.actor)} removed ${nameOf(meta.target)}`;
    case 'member_left': return `${nameOf(meta.actor)} left`;
    default: return 'Conversation updated';
  }
}

/** Name lookup from a member list; "You" for me. */
export function namer(members: Member[] | undefined, meId: string | undefined) {
  const byId = new Map((members ?? []).map((m) => [m.userId, m.displayName]));
  return (id: unknown) => (id === meId ? 'You' : (typeof id === 'string' && byId.get(id)) || 'Someone');
}
