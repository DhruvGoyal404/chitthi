import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createRateLimits, type Limits } from '../src/limits.js';
import type { AvatarFetcher } from '../src/media/avatars.js';
import type { Storage } from '../src/media/storage.js';
import { SESSION_COOKIE } from '../src/sessions.js';
import { uniqueHandle } from './dbhelpers.js';
import { captureLogger, testConfig, WEB_ORIGIN } from './helpers.js';

export type Signed = { id: string; handle: string; cookie: string };

const lots = { points: 100_000, duration: 60 };
export const GENEROUS: Limits = {
  auth: lots, sendBurst: lots, send: lots, socket: lots, search: lots, newDm: lots, groupCreate: lots, memberAdd: lots,
  uploadCount: lots, uploadBytes: { points: 10 * 1024 * 1024 * 1024, duration: 60 },
};

/** The real app, logged in to Postgres as chitthi_api, with dev sign-in on and its own rate-limit namespace. */
export function testApp(
  pool: pg.Pool, apiUrl: string, limits: Limits = GENEROUS,
  extra: { storage?: Storage; env?: Record<string, string>; fetchAvatar?: AvatarFetcher } = {},
): Express {
  const config = testConfig({ DATABASE_URL: apiUrl, DEV_LOGIN: 'true', ...extra.env });
  const { logger } = captureLogger(config);
  const rateLimits = createRateLimits(pool, logger, limits, `t${randomBytes(4).toString('hex')}:`);
  return createApp({ config, logger, pool, rateLimits, ...(extra.storage && { storage: extra.storage }), ...(extra.fetchAvatar && { fetchAvatar: extra.fetchAvatar }) });
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
    put: (path: string, body?: object) => wrap(request(app).put(`/api${path}`)).send(body ?? {}),
    patch: (path: string, body: object) => wrap(request(app).patch(`/api${path}`)).send(body),
    delete: (path: string) => wrap(request(app).delete(`/api${path}`)),
  };
}
