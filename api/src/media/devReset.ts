import { rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type pg from 'pg';

/**
 * Development only: `npm run dev:reset-media` removes every uploaded file and attachment so a
 * manual test pass leaves nothing behind. Never part of the API process.
 */

export type ResetTarget = { nodeEnv: string | undefined; databaseUrl: string | undefined; mediaDir: string; repoRoot: string };

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Throws with the reason unless this is plainly a local development setup. */
export function checkResetTarget(t: ResetTarget): void {
  if (t.nodeEnv === 'production') throw new Error('refused: NODE_ENV is production');
  if (!t.databaseUrl) throw new Error('refused: MIGRATION_DATABASE_URL is not set');
  let host: string;
  try {
    host = new URL(t.databaseUrl).hostname;
  } catch {
    throw new Error('refused: MIGRATION_DATABASE_URL is not a URL');
  }
  if (!LOCAL_HOSTS.has(host)) throw new Error(`refused: the database is not on this machine (${host})`);
  const data = resolve(t.repoRoot, '.data');
  const rel = relative(data, resolve(t.mediaDir));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refused: MEDIA_DIR must be inside ${data}`);
}

export type ResetReport = { messagesTombstoned: number; attachmentsDeleted: number; quotaCountersCleared: number };

/**
 * In one transaction, as the table owner: every message that carried attachments becomes a
 * tombstone (a media message without its media would just look broken), every attachment row
 * is deleted (the no-delete trigger is switched off for that statement only, inside the
 * transaction), and the daily upload quota counters are cleared. Then the media folder goes.
 */
export async function resetDevMedia(client: pg.ClientBase, mediaDir: string): Promise<ResetReport> {
  let report: ResetReport;
  await client.query('BEGIN');
  try {
    const tombstoned = await client.query('UPDATE messages SET deleted_at = now() WHERE attachment_count > 0 AND deleted_at IS NULL');
    await client.query('ALTER TABLE attachments DISABLE TRIGGER attachments_forbid_delete');
    const deleted = await client.query('DELETE FROM attachments');
    await client.query('ALTER TABLE attachments ENABLE TRIGGER attachments_forbid_delete');
    const quota = await client.query("DELETE FROM rate_limits WHERE key LIKE 'uploadCount:%' OR key LIKE 'uploadBytes:%'");
    await client.query('COMMIT');
    report = { messagesTombstoned: tombstoned.rowCount ?? 0, attachmentsDeleted: deleted.rowCount ?? 0, quotaCountersCleared: quota.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  await rm(mediaDir, { recursive: true, force: true });
  return report;
}
