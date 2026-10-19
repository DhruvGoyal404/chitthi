import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True when `origin` is exactly one of the allowed origins. Shared with the WebSocket upgrade check. */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return origin !== undefined && allowed.has(origin);
}

/**
 * CSRF defence: every state-changing request must carry an Origin header from the allowlist.
 * Browsers always send Origin on POST/PUT/PATCH/DELETE; a missing Origin is rejected too, so
 * non-browser clients must set it explicitly.
 */
export function requireAllowedOrigin(allowed: readonly string[]): RequestHandler {
  const allowSet = new Set(allowed);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method) || isAllowedOrigin(req.get('origin'), allowSet)) {
      next();
      return;
    }
    next(new HttpError(403, 'bad_origin', 'Origin not allowed'));
  };
}
