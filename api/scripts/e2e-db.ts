// Runs before the e2e API starts (web/playwright.config.ts): a fresh, migrated throwaway
// database and an empty media folder, so end-to-end runs never touch development data.
//   E2E_ADMIN_DATABASE_URL  owner URL of the e2e database (its name must end in _e2e/_test)
//   DATABASE_URL            the API's login on the same database (same rule)
//   MEDIA_DIR               the e2e media folder (outside <repo>/.data)
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseUrl, dbmate, recreateDatabase } from '../test/dbutil.js';
import { assertDisposableDatabase, assertDisposableMediaDir, databaseName } from './e2eGuard.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const admin = process.env.E2E_ADMIN_DATABASE_URL ?? '';
const api = process.env.DATABASE_URL ?? '';
const mediaDir = process.env.MEDIA_DIR ?? '';

try {
  if (!admin || !api || !mediaDir) throw new Error('refused: E2E_ADMIN_DATABASE_URL, DATABASE_URL and MEDIA_DIR must all be set');
  assertDisposableDatabase(admin);
  assertDisposableDatabase(api);
  if (databaseName(admin) !== databaseName(api)) throw new Error('refused: the admin and API URLs name different databases');
  assertDisposableMediaDir(mediaDir, repoRoot);
} catch (err) {
  console.error(`e2e setup ${(err as Error).message}`);
  process.exit(1);
}

const name = databaseName(admin);
try {
  // Dropping and creating needs a connection to another database: the maintenance one.
  const url = await recreateDatabase(databaseUrl(admin, 'postgres'), name);
  await dbmate(url, 'up');
  const probe = new pg.Client({ connectionString: api });
  await probe.connect();
  await probe.end();
  await rm(mediaDir, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  console.log(`e2e setup: fresh database ${name}, empty media folder ${mediaDir}`);
} catch (err) {
  // Connection strings are never printed.
  console.error(`e2e setup failed: ${(err as Error).message}`);
  process.exit(1);
}
