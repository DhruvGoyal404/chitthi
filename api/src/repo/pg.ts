import pg from 'pg';

export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** Runs `fn` in a READ COMMITTED transaction on one connection; rolls back on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
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
