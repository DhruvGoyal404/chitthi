import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { pino } from 'pino';
import { createPool } from '../src/db.js';

export const APP_ROLE = 'chitthi_app';
const silent = pino({ level: 'silent' });

/** A pool that runs as the API does: owner login, switched to chitthi_app at connection start. */
export function appPool(url: string, max = 10): pg.Pool {
  return createPool(url, silent, { max, role: APP_ROLE });
}

/** Owner pool, for arranging states the app role may not create (e.g. expired sessions). */
export function adminPool(url: string, max = 2): pg.Pool {
  return createPool(url, silent, { max });
}

/** A fresh, valid, non-reserved handle: tests share one database, so never reuse handles. */
export function uniqueHandle(prefix = 'u'): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}
