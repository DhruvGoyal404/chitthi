import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { sendMessage, type Message } from '../src/repo/messages.js';
import { uniqueHandle } from './dbhelpers.js';

export type TestUser = { id: string; handle: string };

/** Users are created directly (as chitthi_app); repository functions only need ids. */
export async function makeUsers(pool: pg.Pool, n: number, prefix = 'u'): Promise<TestUser[]> {
  const handles = Array.from({ length: n }, () => uniqueHandle(prefix));
  const { rows } = await pool.query<TestUser>(
    `INSERT INTO users (handle, display_name) SELECT h, h FROM unnest($1::text[]) WITH ORDINALITY AS t(h, i) ORDER BY i RETURNING id, handle`,
    [handles],
  );
  return rows;
}

export async function send(pool: pg.Pool, conversationId: string, senderId: string, body = `msg ${randomUUID()}`): Promise<Message> {
  return (await sendMessage(pool, { conversationId, senderId, clientMsgId: randomUUID(), body })).message;
}

/** Asserts that a promise rejects with an HttpError of this status and code. */
export async function rejectsWith(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const err = await p.then(
    () => { throw new Error(`expected ${String(status)} ${code}, but it succeeded`); },
    (e: unknown) => e,
  );
  const e = err as { status?: number; code?: string };
  if (e.status !== status || e.code !== code) {
    throw new Error(`expected ${String(status)} ${code}, got ${String(e.status)} ${String(e.code)}: ${String(err)}`);
  }
}
