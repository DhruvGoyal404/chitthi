/** Shape of every API error body (api/src/errors.ts). */
export type ErrorBody = {
  error: { code: string; message: string; issues?: { path: string; message: string }[]; details?: Record<string, unknown> };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isErrorBody(v: unknown): v is ErrorBody {
  if (typeof v !== 'object' || v === null || !('error' in v)) return false;
  const e = v.error;
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}

/**
 * Same-origin fetch to /api (Vite proxies it in dev). Sends cookies, and JSON when given a
 * body. Rejects with ApiError on any non-2xx, using the server's error code when it sent one.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const req: RequestInit = { method: init.method ?? 'GET', credentials: 'same-origin', headers };
  if (init.signal) req.signal = init.signal;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    req.body = JSON.stringify(init.body);
  }
  const res = await fetchImpl(`/api${path}`, req);
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    if (isErrorBody(data)) throw new ApiError(res.status, data.error.code, data.error.message);
    throw new ApiError(res.status, 'http_error', `Request failed (${String(res.status)})`);
  }
  return data as T;
}
