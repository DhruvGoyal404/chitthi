import type { Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';
import { HttpError } from './errors.js';

/** `points` actions per `duration` seconds. */
export type Limit = { points: number; duration: number };

export type Limits = {
  /** Per client IP, across sign-in endpoints (the dev sign-in now, OAuth later). */
  auth: Limit;
  /** Per user, across message sends, edits and deletes. */
  send: Limit;
  /** Socket connections per user. */
  socket: Limit;
};

export const DEFAULT_LIMITS: Limits = {
  auth: { points: 30, duration: 10 * 60 },
  send: { points: 120, duration: 60 },
  socket: { points: 30, duration: 60 },
};

export type RateLimit = (key: string) => Promise<void>;
export type RateLimits = Record<keyof Limits, RateLimit>;

/**
 * Limiters on the Postgres store (the rate_limits table, created by a migration), so limits hold
 * across restarts and API instances with no new infrastructure. A limiter that can't reach its
 * store lets the request through and logs it: failing open keeps the app usable, and anything
 * that can't reach Postgres can't do much else either. `namespace` prefixes every key (tests use
 * it to get counters of their own).
 */
export function createRateLimits(pool: pg.Pool, logger: Logger, limits: Limits = DEFAULT_LIMITS, namespace = ''): RateLimits {
  const make = (name: keyof Limits): RateLimit => {
    const limiter = new RateLimiterPostgres({
      storeClient: pool,
      storeType: 'pool',
      tableName: 'rate_limits',
      tableCreated: true,
      clearExpiredByTimeout: false,
      keyPrefix: `${namespace}${name}`,
      points: limits[name].points,
      duration: limits[name].duration,
    });
    return async (key: string) => {
      try {
        await limiter.consume(key);
      } catch (err) {
        if (err instanceof RateLimiterRes) {
          const retryAfterSeconds = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
          throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${String(retryAfterSeconds)} s.`, { retryAfterSeconds });
        }
        logger.error({ err, limiter: name }, 'rate limiter store failed; allowing the request');
      }
    };
  };
  return { auth: make('auth'), send: make('send'), socket: make('socket') };
}

/** Express middleware: limit by a key derived from the request (429 with Retry-After when exceeded). */
export function limitBy(limit: RateLimit, key: (req: Request, res: Response) => string | undefined): RequestHandler {
  return async (req, res, next) => {
    const k = key(req, res);
    if (k !== undefined) await limit(k);
    next();
  };
}
