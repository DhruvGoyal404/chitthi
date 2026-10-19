import pg from 'pg';
import type { Logger } from 'pino';

// node-pg returns int8 (seq, counters) as strings. Parse to number, refusing anything a JS
// number can't hold exactly; sequences stay far below that, so this only fires on a bug.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} is outside the safe integer range`);
  return n;
});

export type PoolOptions = {
  max?: number;
  /**
   * Role every connection switches to at start-up (the `role` startup parameter, applied before
   * the first query). The API runs as `chitthi_app`; see docs/SCHEMA.md §3.
   */
  role?: string | undefined;
};

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function createPool(databaseUrl: string, logger: Logger, { max = 10, role }: PoolOptions = {}): pg.Pool {
  if (role !== undefined && !ROLE_NAME.test(role)) throw new Error('invalid database role name');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
    ...(role !== undefined && { options: `-c role=${role}` }),
  });
  // An idle client losing its connection emits 'error' on the pool; unhandled, that would crash the process.
  pool.on('error', (err) => {
    logger.error({ err }, 'idle postgres client error');
  });
  return pool;
}

export async function pingDatabase(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
