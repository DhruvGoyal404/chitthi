// Shapes of the API's JSON (dates arrive as ISO strings). Mirrors api/src/repo/*.ts.
export type { Message, MessageEvent } from '../sync/sync.js';

export type Role = 'owner' | 'admin' | 'member';
export type User = { id: string; handle: string; displayName: string };
/** The signed-in user's own profile (/api/me). */
export type Me = User & { avatarUrl: string | null };
export type Provider = 'google' | 'github';
export type Providers = Record<Provider | 'dev', boolean>;
export type Identity = { provider: Provider; email: string | null; linkedAt: string };

export type InboxEntry = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  peer: { id: string; handle: string; displayName: string } | null;
  active: boolean;
  role: Role;
  lastSeq: number;
  changeSeq: number;
  lastMessageAt: string | null;
  lastReadSeq: number;
  lastDeliveredSeq: number;
  unread: number;
  lastMessage: {
    seq: number;
    senderId: string | null;
    kind: 'text' | 'system';
    body: string | null;
    meta: Record<string, unknown> | null;
    deletedAt: string | null;
    createdAt: string;
  } | null;
};

export type Member = {
  userId: string;
  handle: string;
  displayName: string;
  role: Role;
  joinedSeq: number;
  leftSeq: number | null;
  active: boolean;
  lastReadSeq: number;
  lastDeliveredSeq: number;
};

export type ConversationDetail = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  createdBy: string;
  createdAt: string;
  lastSeq: number;
  changeSeq: number;
  myRole: Role | null;
  members: Member[];
  /** Direct conversations: a block stops messages here (mine, or theirs). */
  block: 'by_me' | 'by_them' | null;
};

export type BlockedUser = { userId: string; handle: string; displayName: string; blockedAt: string };

export type PresenceEvent = { userId: string; online: boolean; lastSeenAt: string | null };
export type ReceiptEvent = { conversationId: string; userId: string; seq: number };
export type TypingEvent = { conversationId: string; userId: string; typing: boolean; ttlMs: number };

/** What a conversation is called from `me`'s point of view. */
export function conversationName(c: { kind: 'direct' | 'group'; title: string | null; peer?: InboxEntry['peer'] }): string {
  if (c.kind === 'group') return c.title ?? 'Group';
  return c.peer?.displayName ?? 'Conversation';
}
