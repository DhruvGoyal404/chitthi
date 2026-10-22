import type { Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';
import { HttpError } from './errors.js';

/** `points` actions per `duration` seconds. */
export type Limit = { points: number; duration: number };

export type Limits = {
  /** Per client IP, across sign-in endpoints (OAuth start/callback, onboarding, dev sign-in). */
  auth: Limit;
  /** Per user: message sends, edits and deletes in a short window (a burst)… */
  sendBurst: Limit;
  /** …and over a longer one (sustained). Both must allow a write. */
  send: Limit;
  /** Socket connections per user. */
  socket: Limit;
  /** Handle searches and exact handle lookups per user (anti-enumeration, with ≥3 chars and capped results). */
  search: Limit;
  /** New direct conversations per user per day (opening an existing one is free). */
  newDm: Limit;
  /** New groups per user per day. */
  groupCreate: Limit;
  /** Members added per user per day, including a new group's initial members. */
  memberAdd: Limit;
  /** Uploads per user per day (checked before any bytes are read). */
  uploadCount: Limit;
  /** Bytes stored per user per day (charged with the real size once stored). */
  uploadBytes: Limit;
};

const DAY = 24 * 60 * 60;

/**
 * Generous for people, tight for scripts. A fast typist in a lively chat sends a message every
 * couple of seconds: 30 in 10 s and 400 in 10 minutes leave plenty of room for that.
 */
export const DEFAULT_LIMITS: Limits = {
  auth: { points: 30, duration: 10 * 60 },
  sendBurst: { points: 30, duration: 10 },
  send: { points: 400, duration: 10 * 60 },
  socket: { points: 30, duration: 60 },
  search: { points: 60, duration: 60 },
  newDm: { points: 50, duration: DAY },
  groupCreate: { points: 20, duration: DAY },
  memberAdd: { points: 300, duration: DAY },
  uploadCount: { points: 100, duration: DAY },
  uploadBytes: { points: 200 * 1024 * 1024, duration: DAY },
};

/** What a person reads when a limit stops them (the API adds Retry-After). */
const MESSAGES: Record<keyof Limits, string> = {
  auth: 'Too many sign-in attempts. Please wait a few minutes.',
  sendBurst: "You're sending quickly. Wait a moment, then retry.",
  send: "You've sent a lot of messages in a short while. Wait a few minutes, then retry.",
  socket: 'Too many connections. Please wait a minute.',
  search: 'Too many searches. Please wait a minute.',
  newDm: "You've started a lot of new chats today. Try again tomorrow.",
  groupCreate: "You've created a lot of groups today. Try again tomorrow.",
  memberAdd: "You've added a lot of people today. Try again tomorrow.",
  uploadCount: "You've sent a lot of files today. Try again tomorrow.",
  uploadBytes: "You've sent a lot of data today. Try again tomorrow.",
};

/** DEFAULT_LIMITS with configured overrides (only the sign-in limit is configurable, for e2e runs). */
export function limitsFor(config: { authLimitPoints: number | undefined }): Limits {
  return config.authLimitPoints === undefined ? DEFAULT_LIMITS : { ...DEFAULT_LIMITS, auth: { ...DEFAULT_LIMITS.auth, points: config.authLimitPoints } };
}

/** Consumes `points` (default 1) for `key`, or throws 429 with Retry-After. */
export type RateLimit = (key: string, points?: number) => Promise<void>;
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
    const consume = async (key: string, points = 1) => {
      try {
        await limiter.consume(key, points);
      } catch (err) {
        if (err instanceof RateLimiterRes) {
          const retryAfterSeconds = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
          throw new HttpError(429, 'rate_limited', MESSAGES[name], { retryAfterSeconds, limit: name });
        }
        logger.error({ err, limiter: name }, 'rate limiter store failed; allowing the request');
      }
    };
    return consume;
  };
  const names = Object.keys(DEFAULT_LIMITS) as (keyof Limits)[];
  return Object.fromEntries(names.map((n) => [n, make(n)])) as RateLimits;
}

/** Express middleware: limit by a key derived from the request (429 with Retry-After when exceeded). */
export function limitBy(limit: RateLimit, key: (req: Request, res: Response) => string | undefined): RequestHandler {
  return async (req, res, next) => {
    const k = key(req, res);
    if (k !== undefined) await limit(k);
    next();
  };
}
