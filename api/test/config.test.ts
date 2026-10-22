import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { DB_PASSWORD } from './helpers.js';

describe('config', () => {
  it('applies the Chitthi defaults', () => {
    const c = loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u:p@127.0.0.1:5435/chitthi' });
    expect(c.port).toBe(8082);
    expect(c.host).toBe('127.0.0.1');
    expect(c.webOrigins).toEqual(['http://localhost:5175']);
  });

  it('MEDIA_DIR: absolute only, required in production, <repo>/.data/media otherwise', () => {
    const db = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5435/chitthi' };
    expect(loadConfig({ NODE_ENV: 'development', ...db }).mediaDir).toMatch(/[\\/]\.data[\\/]media$/);
    expect(() => loadConfig({ NODE_ENV: 'production', ...db })).toThrow(/MEDIA_DIR/);
    expect(() => loadConfig({ NODE_ENV: 'development', ...db, MEDIA_DIR: 'relative/media' })).toThrow(/MEDIA_DIR/);
    const abs = process.platform === 'win32' ? 'D:\\chitthi\\media' : '/var/lib/chitthi/media';
    expect(loadConfig({ NODE_ENV: 'production', ...db, MEDIA_DIR: abs }).mediaDir).toBe(abs);
  });

  it('disk guard: production keeps max(15 %, 2 GB) and refuses to start with an override; development may loosen it', () => {
    const db = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5435/chitthi' };
    const prod = { NODE_ENV: 'production', ...db, MEDIA_DIR: process.platform === 'win32' ? 'D:\\media' : '/var/lib/chitthi/media' };
    expect(loadConfig(prod).diskGuard).toEqual({ minFreeRatio: 0.15, minFreeBytes: 2 * 1024 ** 3 });
    expect(() => loadConfig({ ...prod, MEDIA_MIN_FREE_PERCENT: '5' })).toThrow(/MEDIA_MIN_FREE_PERCENT/);
    expect(() => loadConfig({ ...prod, MEDIA_MIN_FREE_BYTES: '1073741824' })).toThrow(/MEDIA_MIN_FREE_BYTES/);
    expect(loadConfig({ NODE_ENV: 'development', ...db }).diskGuard).toEqual({ minFreeRatio: 0.15, minFreeBytes: 2 * 1024 ** 3 });
    expect(loadConfig({ NODE_ENV: 'development', ...db, MEDIA_MIN_FREE_PERCENT: '5', MEDIA_MIN_FREE_BYTES: '1073741824' }).diskGuard)
      .toEqual({ minFreeRatio: 0.05, minFreeBytes: 1024 ** 3 });
    expect(() => loadConfig({ NODE_ENV: 'development', ...db, MEDIA_MIN_FREE_PERCENT: '150' })).toThrow(/MEDIA_MIN_FREE_PERCENT/);
  });

  it('rejects bad values and names the key without echoing the value', () => {
    const badUrl = `mysql://root:${DB_PASSWORD}@db/x`;
    let message = '';
    try {
      loadConfig({ NODE_ENV: 'staging', DATABASE_URL: badUrl, PORT: '99999' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('NODE_ENV');
    expect(message).toContain('PORT');
    expect(message).not.toContain(DB_PASSWORD);
    expect(message).not.toContain(badUrl);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });
});
