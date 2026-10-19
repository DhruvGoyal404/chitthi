import { describe, expect, it } from 'vitest';
import { api, ApiError } from './api.js';

const respond = (status: number, body?: unknown) =>
  (() => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }))) as typeof fetch;

describe('api()', () => {
  it('returns parsed JSON on success', async () => {
    await expect(api('/health', {}, respond(200, { status: 'ok' }))).resolves.toEqual({ status: 'ok' });
  });

  it('maps an API error body to ApiError with its code', async () => {
    const err = await api('/x', {}, respond(403, { error: { code: 'bad_origin', message: 'Origin not allowed' } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'bad_origin', message: 'Origin not allowed' });
  });

  it('copes with a non-JSON error (e.g. the proxy cannot reach the API)', async () => {
    const fetchImpl = (() => Promise.resolve(new Response('Bad Gateway', { status: 502 }))) as typeof fetch;
    await expect(api('/health', {}, fetchImpl)).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });

  it('sends JSON bodies with credentials and the /api prefix', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    await api('/dev/login', { method: 'POST', body: { handle: 'asha' } }, fetchImpl);
    expect(seen?.url).toBe('/api/dev/login');
    expect(seen?.init.credentials).toBe('same-origin');
    expect(seen?.init.body).toBe('{"handle":"asha"}');
    expect((seen?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});
