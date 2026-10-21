import pg from 'pg';
import type { StageTimer } from '../timing.js';

export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/**
 * Runs `fn` in a READ COMMITTED transaction on one connection; rolls back on any error. With a
 * timer, marks pool_wait (getting a connection), transaction (BEGIN + fn) and commit.
 */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>, timer?: StageTimer): Promise<T> {
  const client = await pool.connect();
  timer?.mark('pool_wait');
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    timer?.mark('transaction');
    await client.query('COMMIT');
    timer?.mark('commit');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function pgError(err: unknown): pg.DatabaseError | undefined {
  return err instanceof pg.DatabaseError ? err : undefined;
}

/** The error is a violation of the named constraint (unique 23505, check 23514, …). */
export function violates(err: unknown, constraint: string): boolean {
  return pgError(err)?.constraint === constraint;
}

export const isUniqueViolation = (err: unknown, constraint: string): boolean =>
  pgError(err)?.code === '23505' && violates(err, constraint);
