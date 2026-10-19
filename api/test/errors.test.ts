import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { captureLogger, testConfig, WEB_ORIGIN } from './helpers.js';

const config = testConfig();
const { logger } = captureLogger(config);
const pool = createPool(config.databaseUrl, logger);
const app = createApp({ config, logger, pool });

afterAll(async () => {
  await pool.end();
});

describe('error handling', () => {
  it('answers malformed JSON with 400 invalid_body', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"not": json');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'invalid_body', message: 'Malformed JSON body' } });
  });

  it('answers control-character garbage declared as JSON with 400', async () => {
    // A string, not a Buffer: superagent JSON-serialises Buffers when the type is JSON.
    // test/process.test.ts sends real binary over fetch.
    const res = await request(app)
      .post('/api/anything')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('\u0000ÿ\r\n{\u0007');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('answers an oversized body with 413', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('rejects a state-changing request without an allowed Origin before reading its body', async () => {
    const missing = await request(app).post('/api/anything').set('Content-Type', 'application/json').send('{');
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('bad_origin');
    const foreign = await request(app).post('/api/anything').set('Origin', 'http://evil.example').send({});
    expect(foreign.status).toBe(403);
  });

  it('answers unknown routes with a JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('keeps serving after all of the above, reporting the database as unreachable', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', db: 'unreachable' });
  });

  it('sets hardening headers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
