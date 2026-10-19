import type { TestProject } from 'vitest/node';
import { dbmate, recreateDatabase } from './dbutil.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Owner URL of a freshly migrated `chitthi_test` database, or '' when no database is configured. */
    dbUrl: string;
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
    return;
  }
  const url = await recreateDatabase(admin, 'chitthi_test');
  await dbmate(url, 'up');
  project.provide('dbUrl', url);
}
