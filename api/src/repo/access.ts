import { HttpError } from '../errors.js';
import type { Queryable } from './pg.js';

export type Role = 'owner' | 'admin' | 'member';
export type Access = { kind: 'direct' | 'group'; activeRole: Role | null };

export const notFound = () => new HttpError(404, 'not_found', 'Conversation not found');
export const readOnly = () => new HttpError(403, 'read_only', 'You are no longer a member of this conversation');

/**
 * What `userId` may do in a conversation. Every repository function goes through this (or an
 * equivalent in-statement check): a user with no membership period gets 404, never a hint that
 * the conversation exists.
 */
export async function accessOf(q: Queryable, conversationId: string, userId: string): Promise<Access | undefined> {
  const { rows: [row] } = await q.query<{ kind: 'direct' | 'group'; active_role: Role | null }>(
    `SELECT c.kind, (array_agg(p.role) FILTER (WHERE p.left_at IS NULL))[1] AS active_role
       FROM conversations c JOIN conversation_memberships p ON p.conversation_id = c.id
      WHERE c.id = $1 AND p.user_id = $2
      GROUP BY c.kind`,
    [conversationId, userId],
  );
  return row && { kind: row.kind, activeRole: row.active_role };
}

/** Any membership period, past or present: may read within their windows. */
export async function requireReader(q: Queryable, conversationId: string, userId: string): Promise<Access> {
  const access = await accessOf(q, conversationId, userId);
  if (!access) throw notFound();
  return access;
}

/** An active membership period: may write. */
export async function requireActive(q: Queryable, conversationId: string, userId: string): Promise<Access & { activeRole: Role }> {
  const access = await requireReader(q, conversationId, userId);
  if (access.activeRole === null) throw readOnly();
  return { ...access, activeRole: access.activeRole };
}

/**
 * SQL predicate: message alias `m` lies inside one of the user's membership windows
 * [joined_seq, left_seq]. `userParam` is the placeholder holding the user id, e.g. '$2'.
 */
export function visibleTo(userParam: string, m = 'm'): string {
  return `EXISTS (SELECT 1 FROM conversation_memberships vp
                   WHERE vp.conversation_id = ${m}.conversation_id AND vp.user_id = ${userParam}
                     AND ${m}.seq >= vp.joined_seq AND (vp.left_seq IS NULL OR ${m}.seq <= vp.left_seq))`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Malformed ids are treated like unknown ones: 404 for paths, 400 for request bodies. */
export function assertUuid(value: string, what: string, status: 400 | 404 = 404): void {
  if (!UUID.test(value)) {
    throw status === 404 ? new HttpError(404, 'not_found', `${what} not found`) : new HttpError(400, 'invalid_request', `${what} must be a UUID`);
  }
}
