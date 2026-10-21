import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { findOrCreateDirect } from '../src/repo/conversations.js';
import { withTx } from '../src/repo/pg.js';
import { appPool } from './dbhelpers.js';
import { makeUsers, send } from './fixtures.js';

const url = inject('apiDbUrl');

const key = () => randomBytes(16).toString('hex');
const PLACEHOLDER = 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4IAoAAAAwAQCdASoBAAEAAkA0JaQAA3AA/vuUAAA=';

type Row = Record<string, unknown>;
const image = (uploader: string, over: Row = {}): Row => ({
  uploader_id: uploader, kind: 'image', mime: 'image/jpeg', byte_size: 1000, sha256: randomBytes(32), file_name: 'photo.jpg',
  storage_key: key(), thumb_key: key(), width: 800, height: 600, placeholder: PLACEHOLDER, ...over,
});
const file = (uploader: string, over: Row = {}): Row => ({
  uploader_id: uploader, kind: 'file', mime: 'application/pdf', byte_size: 2000, sha256: randomBytes(32), file_name: 'notes.pdf',
  storage_key: key(), thumb_key: null, width: null, height: null, placeholder: null, ...over,
});

async function insert(q: Pick<pg.Pool, 'query'>, row: Row): Promise<string> {
  const cols = Object.keys(row);
  const { rows: [r] } = await q.query<{ id: string }>(
    `INSERT INTO attachments (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${String(i + 1)}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  if (!r) throw new Error('no row');
  return r.id;
}

/** A media message as the API will send it: the message and its links in one transaction. */
function mediaMessage(pool: pg.Pool, conversationId: string, senderId: string, attachmentIds: string[], count = attachmentIds.length, body: string | null = null) {
  return withTx(pool, async (tx) => {
    const { rows: [m] } = await tx.query<{ id: string; seq: number }>(
      `INSERT INTO messages (conversation_id, sender_id, client_msg_id, send_body_sha256, kind, body, attachment_count)
       VALUES ($1, $2, $3, $4, 'text', $5, $6) RETURNING id, seq`,
      [conversationId, senderId, randomUUID(), createHash('sha256').update(randomUUID()).digest(), body, count],
    );
    if (!m) throw new Error('no row');
    for (const [i, id] of attachmentIds.entries()) {
      await tx.query('UPDATE attachments SET message_id = $1, position = $2 WHERE id = $3', [m.id, i, id]);
    }
    return m;
  });
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { constraint?: string; message?: string }).constraint ?? (e as Error).message);

describe.skipIf(!url)('attachments schema (as chitthi_app)', () => {
  const pool = appPool(url);
  afterAll(async () => {
    await pool.end();
  });

  async function dm() {
    const [a, b] = await makeUsers(pool, 2, 'att');
    if (!a || !b) throw new Error('fixture');
    const { conversation } = await findOrCreateDirect(pool, a.id, b.id);
    return { a, b, conv: conversation.id };
  }

  it('accepts only the allowlisted types, shapes and sizes', async () => {
    const { a } = await dm();
    expect(await code(insert(pool, image(a.id)))).toBe('ok');
    expect(await code(insert(pool, file(a.id)))).toBe('ok');
    expect(await code(insert(pool, file(a.id, { mime: 'text/plain', file_name: 'a.txt' })))).toBe('ok');
    expect(await code(insert(pool, file(a.id, { mime: 'application/zip', file_name: 'a.zip' })))).toBe('ok');
    expect(await code(insert(pool, image(a.id, { mime: 'image/svg+xml' })))).toBe('attachments_mime_check');
    expect(await code(insert(pool, file(a.id, { mime: 'text/html' })))).toBe('attachments_mime_check');
    expect(await code(insert(pool, image(a.id, { mime: 'image/gif' })))).toBe('attachments_mime_check'); // GIFs are re-encoded to PNG
    expect(await code(insert(pool, file(a.id, { mime: 'image/png' })))).toBe('attachments_mime_check');
    expect(await code(insert(pool, image(a.id, { byte_size: 10 * 1024 * 1024 + 1 })))).toBe('attachments_size_check');
    expect(await code(insert(pool, file(a.id, { byte_size: 25 * 1024 * 1024 + 1 })))).toBe('attachments_size_check');
    // NULLs must not slip through (a CHECK that evaluates to NULL passes).
    for (const missing of ['width', 'height', 'placeholder', 'thumb_key']) {
      expect(await code(insert(pool, image(a.id, { [missing]: null }))), missing).toBe('attachments_image_shape');
    }
    expect(await code(insert(pool, image(a.id, { placeholder: 'data:text/html;base64,PHNjcmlwdD4=' })))).toBe('attachments_image_shape');
    expect(await code(insert(pool, file(a.id, { width: 10 })))).toBe('attachments_image_shape');
    for (const name of ['../../etc/passwd', 'a\\b.pdf', 'line\nbreak.pdf', '']) {
      expect(await code(insert(pool, file(a.id, { file_name: name }))), JSON.stringify(name)).toBe('attachments_file_name_check');
    }
    expect(await code(insert(pool, file(a.id, { storage_key: '../x' })))).toBe('attachments_storage_key_format');
  });

  it('a media message: caption optional, links verified against attachment_count at commit', async () => {
    const { a, conv } = await dm();
    const [i1, i2] = [await insert(pool, image(a.id)), await insert(pool, file(a.id))];
    const m = await mediaMessage(pool, conv, a.id, [i1, i2]);
    const { rows } = await pool.query('SELECT id, position, attached_at IS NOT NULL AS attached FROM attachments WHERE message_id = $1 ORDER BY position', [m.id]);
    expect(rows).toEqual([{ id: i1, position: 0, attached: true }, { id: i2, position: 1, attached: true }]);

    // Count says 2, only 1 linked: refused at commit, and the message is rolled back with it.
    const i3 = await insert(pool, image(a.id));
    expect(await code(mediaMessage(pool, conv, a.id, [i3], 2))).toBe('messages_attachment_count_matches');
    expect((await pool.query('SELECT message_id FROM attachments WHERE id = $1', [i3])).rows[0]).toEqual({ message_id: null });
    // No attachments and no body: still refused.
    expect(await code(mediaMessage(pool, conv, a.id, [], 0))).toBe('messages_live_text');
    expect(await code(mediaMessage(pool, conv, a.id, [], 11))).toBe('messages_attachment_count_check');
    // Linking without a position is refused too (NULL must not pass the CHECK).
    const i4 = await insert(pool, image(a.id));
    const linkNoPosition = withTx(pool, async (tx) => {
      const { rows: [msg] } = await tx.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_id, client_msg_id, send_body_sha256, kind, body, attachment_count)
         VALUES ($1, $2, $3, $4, 'text', NULL, 1) RETURNING id`,
        [conv, a.id, randomUUID(), randomBytes(32)],
      );
      await tx.query('UPDATE attachments SET message_id = $1 WHERE id = $2', [msg?.id, i4]);
    });
    expect(await code(linkNoPosition)).toBe('attachments_link_shape');
  });

  it("links only the uploader's own unattached uploads, to a message created in the same transaction", async () => {
    const { a, b, conv } = await dm();
    const theirs = await insert(pool, image(b.id));
    expect(await code(mediaMessage(pool, conv, a.id, [theirs]))).toBe('attachments_link_rules');
    const mine = await insert(pool, image(a.id));
    const first = await mediaMessage(pool, conv, a.id, [mine]);
    expect(await code(mediaMessage(pool, conv, a.id, [mine]))).toBe('an attachment belongs to one message for good');
    // An existing message can't gain media later.
    const old = await send(pool, conv, a.id, 'plain text');
    const late = await insert(pool, image(a.id));
    expect(await code(pool.query('UPDATE attachments SET message_id = $1, position = 0 WHERE id = $2', [old.id, late]))).toBe('attachments_link_rules');
    expect(first.seq).toBeGreaterThan(0);
  });

  it('a tombstone marks its attachments deleted in the same transaction; rows are never hard-deleted', async () => {
    const { a, conv } = await dm();
    const ids = [await insert(pool, image(a.id)), await insert(pool, file(a.id))];
    const m = await mediaMessage(pool, conv, a.id, ids, 2, 'with a caption');
    await pool.query('UPDATE messages SET deleted_at = now() WHERE id = $1', [m.id]);
    const { rows } = await pool.query<{ deleted: boolean }>('SELECT deleted_at IS NOT NULL AS deleted FROM attachments WHERE id = ANY($1::uuid[])', [ids]);
    expect(rows).toEqual([{ deleted: true }, { deleted: true }]);
    expect(await code(pool.query('DELETE FROM attachments WHERE id = $1', [ids[0]]))).toMatch(/permission denied|never hard-deleted/);
    expect(await code(pool.query("UPDATE attachments SET file_name = 'x.pdf' WHERE id = $1", [ids[1]]))).toMatch(/permission denied|immutable/);
  });
});
