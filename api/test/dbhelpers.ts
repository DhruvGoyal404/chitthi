import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import { createPool } from '../src/db.js';

const silent = pino({ level: 'silent' });

/** A pool exactly like the API's: logged in as chitthi_api (inject('apiDbUrl')). */
export function appPool(apiUrl: string, max = 10): pg.Pool {
  // Concurrency tests queue far more work than `max` on purpose; give checkouts room under load.
  return createPool(apiUrl, silent, { max, connectionTimeoutMillis: 15_000 });
}

/** Owner pool (inject('dbUrl')), for arranging states the app may not create (e.g. expired sessions). */
export function adminPool(url: string, max = 2): pg.Pool {
  return createPool(url, silent, { max });
}

/** A fresh, valid, non-reserved handle: tests share one database, so never reuse handles. */
export function uniqueHandle(prefix = 'u'): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}
