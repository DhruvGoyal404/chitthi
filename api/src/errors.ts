import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** Error with a client-safe status, code and message. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** At most this many validation issues go back to the client. */
export const MAX_ISSUES = 10;

export type ErrorBody = {
  error: { code: string; message: string; issues?: { path: string; message: string }[]; details?: Record<string, unknown> };
};

/** body-parser errors (malformed JSON, too large, bad charset) carry a 4xx status and `expose: true`. */
function isClientParserError(err: unknown): err is { status: number; type: string; expose: true } {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return typeof e.status === 'number' && e.status >= 400 && e.status < 500 && e.expose === true && typeof e.type === 'string';
}

export const notFound: RequestHandler = (_req, res) => {
  const body: ErrorBody = { error: { code: 'not_found', message: 'Not found' } };
  res.status(404).json(body);
};

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  let status = 500;
  let body: ErrorBody = { error: { code: 'internal', message: 'Internal server error' } };

  if (err instanceof HttpError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) } };
  } else if (err instanceof ZodError) {
    status = 400;
    body = {
      error: {
        code: 'invalid_request',
        message: 'Request validation failed',
        // A bounded list: the response must never grow with how wrong the input is.
        issues: err.issues.slice(0, MAX_ISSUES).map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  } else if (isClientParserError(err)) {
    status = err.status;
    const code = err.type === 'entity.too.large' ? 'payload_too_large' : 'invalid_body';
    body = { error: { code, message: err.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Invalid request body' } };
  }

  if (status >= 500) req.log.error({ err }, 'unhandled error');
  else req.log.info({ code: body.error.code }, 'client error');
  const retryAfter = body.error.details?.retryAfterSeconds;
  if (status === 429 && typeof retryAfter === 'number') res.set('Retry-After', String(retryAfter));
  res.status(status).json(body);
};
