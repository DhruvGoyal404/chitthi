import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const require = createRequire(import.meta.url);
const DBMATE_CLI = join(dirname(require.resolve('dbmate')), 'cli.js');
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

/** Same server and credentials as `adminUrl`, different database. */
export function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Drops (if present) and creates a database owned by the admin role. Test databases only. */
export async function recreateDatabase(adminUrl: string, database: string): Promise<string> {
  if (!/^chitthi_[a-z0-9_]+$/.test(database)) throw new Error(`refusing to recreate ${database}`);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${database}`);
  } finally {
    await client.end();
  }
  return databaseUrl(adminUrl, database);
}

export async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  if (!/^chitthi_[a-z0-9_]+$/.test(database)) throw new Error(`refusing to drop ${database}`);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

/** Runs the pinned dbmate binary against `url`. Output is returned, never printed (it would carry the URL). */
export function dbmate(url: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DBMATE_CLI, '--url', url, '--migrations-dir', MIGRATIONS_DIR, '--no-dump-schema', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`dbmate ${args.join(' ')} exited ${String(code)}: ${out.replace(/\/\/[^@\s]*@/g, '//[redacted]@')}`));
    });
  });
}
