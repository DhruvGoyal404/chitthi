import pg from 'pg';
import type { Logger } from 'pino';

// node-pg returns int8 (seq, counters) as strings. Parse to number, refusing anything a JS
// number can't hold exactly; sequences stay far below that, so this only fires on a bug.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} is outside the safe integer range`);
  return n;
});

/** The API connects as chitthi_api (docs/SCHEMA.md §3): least privilege comes from the login itself. */
export function createPool(databaseUrl: string, logger: Logger, { max = 10 }: { max?: number } = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
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
