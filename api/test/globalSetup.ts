import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { databaseUrl, dbmate, recreateDatabase } from './dbutil.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Owner URL of a freshly migrated `chitthi_test` database, or '' when no database is configured. */
    dbUrl: string;
    /** The API's login (chitthi_api) on `chitthi_test`: every app query in tests runs as this. */
    apiDbUrl: string;
    /** TEST_DATABASE_URL: owner credentials on the cluster, for tests that create their own databases. */
    adminDbUrl: string;
  }
}

/**
 * When TEST_DATABASE_URL is set (CI, or a local .env), every run starts from a fresh, fully
 * migrated `chitthi_test` database, so DB tests never touch the dev database or each other's
 * leftovers from earlier runs. Without it, DB tests skip.
 */
export default async function setup(project: TestProject): Promise<void> {
  const admin = process.env.TEST_DATABASE_URL ?? '';
  project.provide('adminDbUrl', admin);
  if (!admin) {
    project.provide('dbUrl', '');
    project.provide('apiDbUrl', '');
    return;
  }
  const apiBase = process.env.TEST_API_DATABASE_URL;
  if (!apiBase) throw new Error('TEST_API_DATABASE_URL must be set with TEST_DATABASE_URL (see .env.example)');
  const url = await recreateDatabase(admin, 'chitthi_test');
  await dbmate(url, 'up');
  const apiUrl = databaseUrl(apiBase, 'chitthi_test');

  // Fail fast with a clear message if the API login isn't set up (npm run db:api-password).
  const probe = new pg.Client({ connectionString: apiUrl });
  try {
    await probe.connect();
    await probe.end();
  } catch (err) {
    throw new Error(`cannot log in as chitthi_api; run npm run db:api-password (${(err as Error).message})`, { cause: err });
  }

  project.provide('dbUrl', url);
  project.provide('apiDbUrl', apiUrl);
}
