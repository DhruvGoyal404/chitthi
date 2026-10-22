import type pg from 'pg';
import type { Logger } from 'pino';
import type { Storage } from './storage.js';

/** Uploads not attached to a message within this long are swept. */
export const ORPHAN_AFTER_MS = 60 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const BATCH = 500;

export type PurgeScope = { messageId?: string; uploaderId?: string };

/**
 * Removes the files of attachments marked deleted (tombstone, account erase, orphan sweep) and
 * records blob_removed_at. Deleting is idempotent, so a crash between removing the files and
 * recording it only means the next run removes nothing and records it. A failure is logged and
 * left for the sweeper; the row stays pending. Returns how many were finished.
 */
export async function purgeDeleted(pool: pg.Pool, storage: Storage, logger: Logger, scope: PurgeScope = {}): Promise<number> {
  const { rows } = await pool.query<{ id: string; storage_key: string; thumb_key: string | null }>(
    `SELECT id, storage_key, thumb_key FROM attachments
      WHERE deleted_at IS NOT NULL AND blob_removed_at IS NULL
        AND ($1::uuid IS NULL OR message_id = $1) AND ($2::uuid IS NULL OR uploader_id = $2)
      ORDER BY deleted_at LIMIT ${String(BATCH)}`,
    [scope.messageId ?? null, scope.uploaderId ?? null],
  );
  let done = 0;
  for (const a of rows) {
    try {
      await storage.delete(a.storage_key);
      if (a.thumb_key) await storage.delete(a.thumb_key);
      await pool.query('UPDATE attachments SET blob_removed_at = now() WHERE id = $1 AND blob_removed_at IS NULL', [a.id]);
      done++;
    } catch (err) {
      logger.warn({ err, attachmentId: a.id }, 'could not remove an attachment file; the sweeper will retry');
    }
  }
  return done;
}

/** Marks uploads that were never attached within the hour as deleted (their files go next). */
export async function sweepOrphans(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE attachments SET deleted_at = now()
      WHERE message_id IS NULL AND deleted_at IS NULL AND created_at < now() - make_interval(secs => $1)`,
    [ORPHAN_AFTER_MS / 1000],
  );
  return rowCount ?? 0;
}

/**
 * Removes stored objects that no attachment row knows about (a crash between storing a file and
 * inserting its row), once they are older than the orphan window so an upload in progress is
 * never touched; and partial writes left in the store's temporary area.
 */
export async function reconcileStore(pool: pg.Pool, storage: Storage, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ORPHAN_AFTER_MS);
  let removed = await storage.cleanTemp(cutoff);
  let batch: string[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const { rows } = await pool.query<{ key: string }>(
      `SELECT k AS key FROM unnest($1::text[]) AS k
        WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.storage_key = k OR a.thumb_key = k)`,
      [batch],
    );
    for (const { key } of rows) {
      await storage.delete(key);
      removed++;
    }
    batch = [];
  };
  for await (const obj of storage.list()) {
    if (obj.modifiedAt >= cutoff) continue;
    batch.push(obj.key);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return removed;
}

export type SweepReport = { orphans: number; purged: number; reconciled: number };

/** One full pass: mark orphans, remove pending files (retrying past failures), reconcile the store. */
export async function sweepOnce(pool: pg.Pool, storage: Storage, logger: Logger): Promise<SweepReport> {
  const orphans = await sweepOrphans(pool);
  let purged = 0;
  for (let n = await purgeDeleted(pool, storage, logger); n > 0; n = await purgeDeleted(pool, storage, logger)) {
    purged += n;
    if (n < BATCH) break;
  }
  const reconciled = await reconcileStore(pool, storage);
  if (orphans + purged + reconciled > 0) logger.info({ orphans, purged, reconciled }, 'media sweep');
  return { orphans, purged, reconciled };
}

/** Runs sweepOnce every intervalMs (0 disables it, as the tests do). Never overlaps itself. */
export function startSweeper(pool: pg.Pool, storage: Storage, logger: Logger, intervalMs = DEFAULT_SWEEP_INTERVAL_MS) {
  if (intervalMs <= 0) return { stop: () => Promise.resolve() };
  let running: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = sweepOnce(pool, storage, logger)
      .catch((err: unknown) => { logger.error({ err }, 'media sweep failed'); })
      .finally(() => { running = undefined; });
  }, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
