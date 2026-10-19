import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createRateLimits, type Limits } from '../src/limits.js';
import { SESSION_COOKIE } from '../src/sessions.js';
import { uniqueHandle } from './dbhelpers.js';
import { captureLogger, testConfig, WEB_ORIGIN } from './helpers.js';

export type Signed = { id: string; handle: string; cookie: string };

export const GENEROUS: Limits = { auth: { points: 10_000, duration: 60 }, send: { points: 10_000, duration: 60 }, socket: { points: 10_000, duration: 60 } };

/** The real app, logged in to Postgres as chitthi_api, with dev sign-in on and its own rate-limit namespace. */
export function testApp(pool: pg.Pool, apiUrl: string, limits: Limits = GENEROUS): Express {
  const config = testConfig({ DATABASE_URL: apiUrl, DEV_LOGIN: 'true' });
  const { logger } = captureLogger(config);
  const rateLimits = createRateLimits(pool, logger, limits, `t${randomBytes(4).toString('hex')}:`);
  return createApp({ config, logger, pool, rateLimits });
}

export type Target = Express | string;

/** Signs a new user in through the real dev sign-in route (an app, or a running server URL). */
export async function signIn(app: Target, prefix = 'u'): Promise<Signed> {
  const res = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ handle: uniqueHandle(prefix) });
  if (res.status !== 201) throw new Error(`sign-in failed: ${String(res.status)} ${JSON.stringify(res.body)}`);
  const raw = res.headers['set-cookie'] as unknown as string[];
  const cookie = raw.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
  if (!cookie) throw new Error('no session cookie');
  const user = res.body.user as { id: string; handle: string };
  return { ...user, cookie };
}

/** A request builder carrying a user's cookie and the allowed Origin. */
export function as(app: Target, user: Signed) {
  const wrap = (r: request.Test) => r.set('Cookie', user.cookie).set('Origin', WEB_ORIGIN);
  return {
    get: (path: string) => wrap(request(app).get(`/api${path}`)),
    post: (path: string, body?: object) => wrap(request(app).post(`/api${path}`)).send(body ?? {}),
    patch: (path: string, body: object) => wrap(request(app).patch(`/api${path}`)).send(body),
    delete: (path: string) => wrap(request(app).delete(`/api${path}`)),
  };
}
