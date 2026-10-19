import { readdirSync } from 'node:fs';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { dbmate, dropDatabase, MIGRATIONS_DIR, recreateDatabase } from './dbutil.js';

const admin = inject('adminDbUrl');
const DB = 'chitthi_schema_roundtrip';

// Everything that defines the schema, as comparable JSON: columns, constraints, indexes,
// triggers, function bodies and security settings, the app role's grants, and seed data.
const SNAPSHOT = `
SELECT json_build_object(
  'columns', (SELECT json_agg(x ORDER BY x.table_name, x.ordinal_position) FROM (
      SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public') x),
  'constraints', (SELECT json_agg(x ORDER BY x.rel, x.conname) FROM (
      SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace) x),
  'indexes', (SELECT json_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public'),
  'triggers', (SELECT json_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal),
  'functions', (SELECT json_agg(json_build_object('def', pg_get_functiondef(p.oid), 'secdef', p.prosecdef, 'config', p.proconfig) ORDER BY p.proname)
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
  'table_grants', (SELECT json_agg(x ORDER BY x.table_name, x.privilege_type) FROM (
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'chitthi_app' AND table_schema = 'public') x),
  'column_grants', (SELECT json_agg(x ORDER BY x.table_name, x.column_name, x.privilege_type) FROM (
      SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
       WHERE grantee = 'chitthi_app' AND table_schema = 'public') x),
  'schema_usage', EXISTS (SELECT 1 FROM aclexplode((SELECT nspacl FROM pg_namespace WHERE nspname = 'public')) a WHERE a.grantee = 'chitthi_app'::regrole),
  'reserved_handles', (SELECT json_agg(handle ORDER BY handle) FROM reserved_handles)
) AS snapshot`;

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe.skipIf(!admin)('migrations', () => {
  afterAll(async () => {
    if (admin) await dropDatabase(admin, DB);
  });

  it('go up → down → up to an identical schema, and down leaves nothing behind', async () => {
    const url = await recreateDatabase(admin, DB);
    const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(migrations.length).toBeGreaterThanOrEqual(3);

    await dbmate(url, 'up');
    const first = await withClient(url, async (c) => (await c.query<{ snapshot: unknown }>(SNAPSHOT)).rows[0]?.snapshot);
    expect(JSON.stringify(first)).toContain('messages_before_insert'); // the snapshot really covers the schema

    for (let i = 0; i < migrations.length; i++) await dbmate(url, 'rollback');
    const leftovers = await withClient(url, async (c) => (await c.query<{ tables: string[] | null; functions: number; usage: boolean }>(`
      SELECT (SELECT array_agg(tablename::text) FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations') AS tables,
             (SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'public'::regnamespace) AS functions,
             EXISTS (SELECT 1 FROM aclexplode((SELECT nspacl FROM pg_namespace WHERE nspname = 'public')) a WHERE a.grantee = 'chitthi_app'::regrole) AS usage`)).rows[0]);
    expect(leftovers).toEqual({ tables: null, functions: 0, usage: false });

    await dbmate(url, 'up');
    const second = await withClient(url, async (c) => (await c.query<{ snapshot: unknown }>(SNAPSHOT)).rows[0]?.snapshot);
    expect(second).toEqual(first);
  });
});
