import { Router, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireSession, sessionOf } from './auth.js';
import { HttpError } from './errors.js';
import { limitBy, type RateLimits } from './limits.js';
import {
  addMember, createGroup, findOrCreateDirect, getConversation, leave, listConversations, removeMember,
} from './repo/conversations.js';
import {
  catchUpByChange, catchUpBySeq, deleteForEveryone, editMessage, history, markRead, MAX_PAGE, messageReceipts, sendMessage,
} from './repo/messages.js';
import { findUserByHandle, searchUsers } from './repo/users.js';
import type { SessionStore } from './sessions.js';

const uuid = z.uuid();
const seq = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const limit = z.coerce.number().int().min(1).max(MAX_PAGE).optional();

const sendBody = z.object({ clientMsgId: uuid, body: z.string() });
const editBody = z.object({ body: z.string() });
const directBody = z.object({ userId: uuid });
const groupBody = z.object({ title: z.string(), memberIds: z.array(uuid).max(255).default([]) });
const addMemberBody = z.object({ userId: uuid, role: z.enum(['admin', 'member']).optional() });
const readBody = z.object({ seq });
const messagesQuery = z
  .object({ before: seq.optional(), after: seq.optional(), limit })
  .refine((q) => q.before === undefined || q.after === undefined, 'use before or after, not both');
const changesQuery = z.object({ after: seq, limit });
const searchQuery = z.object({ q: z.string().trim().regex(/^[A-Za-z0-9_]{2,20}$/, '2–20 characters: letters, digits or _') });

/** Path ids are validated like everything else: a malformed id is simply not found. */
function pathId(value: unknown, what: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'not_found', `${what} not found`);
  return parsed.data;
}
const me = (res: Response) => sessionOf(res).user.id;

/**
 * The REST API. Every message write (send, edit, delete) happens here and nowhere else; the
 * response is the stored row with its seq, which is the client's acknowledgement. Sockets only
 * push what was committed (docs/REALTIME.md).
 */
export function apiRoutes(pool: pg.Pool, sessions: SessionStore, rateLimits: RateLimits): Router {
  const r = Router();
  r.use(['/conversations', '/users'], requireSession(sessions));
  const sendLimit = limitBy(rateLimits.send, (_req, res) => me(res));
  const searchLimit = limitBy(rateLimits.search, (_req, res) => me(res));

  r.get('/users', searchLimit, async (req, res) => {
    const { q } = searchQuery.parse(req.query);
    res.json({ users: await searchUsers(pool, q, me(res)) });
  });

  r.get('/users/:handle', async (req, res) => {
    const user = await findUserByHandle(pool, req.params.handle);
    if (!user) throw new HttpError(404, 'user_not_found', 'User not found');
    res.json({ user });
  });

  r.get('/conversations', async (_req, res) => {
    res.json({ conversations: await listConversations(pool, me(res)) });
  });

  r.get('/conversations/:id', async (req, res) => {
    res.json({ conversation: await getConversation(pool, pathId(req.params.id, 'Conversation'), me(res)) });
  });

  r.post('/conversations/direct', async (req, res) => {
    const { userId } = directBody.parse(req.body);
    const { conversation, created } = await findOrCreateDirect(pool, me(res), userId);
    res.status(created ? 201 : 200).json({ conversation });
  });

  r.post('/conversations', async (req, res) => {
    const { title, memberIds } = groupBody.parse(req.body);
    res.status(201).json({ conversation: await createGroup(pool, { creatorId: me(res), title, memberIds }) });
  });

  r.post('/conversations/:id/members', async (req, res) => {
    const { userId, role } = addMemberBody.parse(req.body);
    const conversationId = pathId(req.params.id, 'Conversation');
    res.status(201).json(await addMember(pool, { conversationId, actorId: me(res), userId, ...(role && { role }) }));
  });

  r.delete('/conversations/:id/members/:userId', async (req, res) => {
    const conversationId = pathId(req.params.id, 'Conversation');
    const userId = pathId(req.params.userId, 'Member');
    res.json(await removeMember(pool, { conversationId, actorId: me(res), userId }));
  });

  r.post('/conversations/:id/leave', async (req, res) => {
    res.json(await leave(pool, { conversationId: pathId(req.params.id, 'Conversation'), userId: me(res) }));
  });

  // History (before) or seq catch-up (after); newest page when neither is given.
  r.get('/conversations/:id/messages', async (req, res) => {
    const conversationId = pathId(req.params.id, 'Conversation');
    const q = messagesQuery.parse(req.query);
    const page = q.after !== undefined
      ? await catchUpBySeq(pool, { conversationId, userId: me(res), afterSeq: q.after, ...(q.limit && { limit: q.limit }) })
      : await history(pool, { conversationId, userId: me(res), ...(q.before !== undefined && { beforeSeq: q.before }), ...(q.limit && { limit: q.limit }) });
    res.json(page);
  });

  r.get('/conversations/:id/changes', async (req, res) => {
    const conversationId = pathId(req.params.id, 'Conversation');
    const q = changesQuery.parse(req.query);
    res.json(await catchUpByChange(pool, { conversationId, userId: me(res), afterChange: q.after, ...(q.limit && { limit: q.limit }) }));
  });

  r.post('/conversations/:id/messages', sendLimit, async (req, res) => {
    const conversationId = pathId(req.params.id, 'Conversation');
    const { clientMsgId, body } = sendBody.parse(req.body);
    const { message, duplicate } = await sendMessage(pool, { conversationId, senderId: me(res), clientMsgId, body });
    res.status(duplicate ? 200 : 201).json({ message, duplicate });
  });

  r.patch('/conversations/:id/messages/:messageId', sendLimit, async (req, res) => {
    const conversationId = pathId(req.params.id, 'Conversation');
    const messageId = pathId(req.params.messageId, 'Message');
    const { body } = editBody.parse(req.body);
    res.json({ message: await editMessage(pool, { conversationId, messageId, userId: me(res), body }) });
  });

  r.delete('/conversations/:id/messages/:messageId', sendLimit, async (req, res) => {
    const conversationId = pathId(req.params.id, 'Conversation');
    const messageId = pathId(req.params.messageId, 'Message');
    res.json({ message: await deleteForEveryone(pool, { conversationId, messageId, userId: me(res) }) });
  });

  r.get('/conversations/:id/messages/:messageId/receipts', async (req, res) => {
    const conversationId = pathId(req.params.id, 'Conversation');
    const messageId = pathId(req.params.messageId, 'Message');
    res.json({ receipts: await messageReceipts(pool, { conversationId, messageId, userId: me(res) }) });
  });

  r.post('/conversations/:id/read', async (req, res) => {
    const conversationId = pathId(req.params.id, 'Conversation');
    const { seq: upTo } = readBody.parse(req.body);
    res.json(await markRead(pool, { conversationId, userId: me(res), seq: upTo }));
  });

  return r;
}
