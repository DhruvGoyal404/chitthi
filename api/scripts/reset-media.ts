// npm run dev:reset-media: deletes every attachment (rows and files) from the local dev setup.
// Refuses production, a database that isn't on this machine, and a MEDIA_DIR outside <repo>/.data.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { checkResetTarget, resetDevMedia } from '../src/media/devReset.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const mediaDir = process.env.MEDIA_DIR ?? resolve(repoRoot, '.data/media');
const databaseUrl = process.env.MIGRATION_DATABASE_URL;

try {
  checkResetTarget({ nodeEnv: process.env.NODE_ENV, databaseUrl, mediaDir, repoRoot });
} catch (err) {
  console.error(`dev:reset-media ${(err as Error).message}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  const r = await resetDevMedia(client, mediaDir);
  console.log(`dev:reset-media: ${String(r.attachmentsDeleted)} attachments deleted, ${String(r.messagesTombstoned)} messages with media now "deleted", ${String(r.quotaCountersCleared)} upload quota counters cleared, ${mediaDir} removed.`);
} catch (err) {
  // The owner's connection string is never printed; only what went wrong.
  console.error(`dev:reset-media failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
