import type { Request, RequestHandler, Response } from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { HttpError } from './errors.js';

/** `points` actions per `duration` seconds. */
export type Limit = { points: number; duration: number };

export type Limits = {
  /** Per client IP, across sign-in endpoints (the dev sign-in now, OAuth later). */
  auth: Limit;
};

export const DEFAULT_LIMITS: Limits = {
  auth: { points: 30, duration: 10 * 60 },
};

export type RateLimit = (key: string) => Promise<void>;
export type RateLimits = Record<keyof Limits, RateLimit>;

/**
 * In-memory limiters for Phase 1. They move to the Postgres store (a `rate_limits` table) with
 * the domain schema, so limits hold across restarts and API instances.
 */
export function createRateLimits(limits: Limits = DEFAULT_LIMITS): RateLimits {
  const make = (name: keyof Limits): RateLimit => {
    const limiter = new RateLimiterMemory({ keyPrefix: name, points: limits[name].points, duration: limits[name].duration });
    return async (key: string) => {
      try {
        await limiter.consume(key);
      } catch (err) {
        if (!(err instanceof RateLimiterRes)) throw err;
        const retryAfterSeconds = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
        throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${String(retryAfterSeconds)} s.`, { retryAfterSeconds });
      }
    };
  };
  return { auth: make('auth') };
}

/** Express middleware: limit by a key derived from the request (429 with Retry-After when exceeded). */
export function limitBy(limit: RateLimit, key: (req: Request, res: Response) => string | undefined): RequestHandler {
  return async (req, res, next) => {
    const k = key(req, res);
    if (k !== undefined) await limit(k);
    next();
  };
}
