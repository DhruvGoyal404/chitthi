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
