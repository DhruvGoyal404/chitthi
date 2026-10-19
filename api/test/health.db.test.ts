import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { captureLogger, testConfig } from './helpers.js';

// Needs a migrated Postgres (CI provides one; locally: docker compose up -d db && npm run db:migrate).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('health against a real database', () => {
  const config = testConfig(url ? { DATABASE_URL: url } : {});
  const { logger } = captureLogger(config);
  const pool = createPool(config.databaseUrl, logger);

  afterAll(async () => {
    await pool.end();
  });

  it('reports ok', async () => {
    const res = await request(createApp({ config, logger, pool })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('runs on Postgres 18 with the baseline migration applied', async () => {
    const { rows: [server] } = await pool.query<{ v: number }>("select current_setting('server_version_num')::int as v");
    expect(server?.v).toBeGreaterThanOrEqual(180000);
    const { rows } = await pool.query<{ version: string }>('select version from schema_migrations order by version');
    expect(rows.map((r) => r.version)).toContain('20261019000000');
  });
});
