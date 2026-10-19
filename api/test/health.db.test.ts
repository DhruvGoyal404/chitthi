import request from 'supertest';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { adminPool } from './dbhelpers.js';
import { captureLogger, testConfig } from './helpers.js';

// globalSetup provides a freshly migrated database when TEST_DATABASE_URL is set.
const url = inject('apiDbUrl');
const ownerUrl = inject('dbUrl');

describe.skipIf(!url)('health against a real database', () => {
  const config = testConfig(url ? { DATABASE_URL: url } : {});
  const { logger } = captureLogger(config);
  const pool = createPool(config.databaseUrl, logger);
  const owner = adminPool(ownerUrl);

  afterAll(async () => {
    await Promise.all([pool.end(), owner.end()]);
  });

  it('reports ok', async () => {
    const res = await request(createApp({ config, logger, pool })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('runs on Postgres 18 with every migration applied (as chitthi_api)', async () => {
    const { rows: [server] } = await pool.query<{ v: number }>("select current_setting('server_version_num')::int as v");
    expect(server?.v).toBeGreaterThanOrEqual(180000);
    // schema_migrations belongs to the owner: the API login cannot even read it.
    await expect(pool.query('select 1 from schema_migrations')).rejects.toThrow(/permission denied/);
    const { rows } = await owner.query<{ version: string }>('select version from schema_migrations order by version');
    expect(rows.map((r) => r.version)).toEqual(['20261019000000', '20261019110000', '20261019120000', '20261020090000']);
  });
});
