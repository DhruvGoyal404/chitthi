import { describe, expect, it } from 'vitest';
import { scrubLine } from '../src/logger.js';
import { captureLogger, DB_PASSWORD, testConfig, UNREACHABLE_DB_URL } from './helpers.js';

describe('logger never leaks secrets', () => {
  it('redacts the config object, error messages and stacks', () => {
    const config = testConfig();
    const { logger, output } = captureLogger(config);

    logger.info({ config }, 'config loaded');
    logger.error({ err: new Error(`could not connect to ${UNREACHABLE_DB_URL}`) }, 'db failed');
    logger.warn(`retrying ${config.databaseUrl}`);
    logger.info({ nested: { connectionString: config.databaseUrl, password: 'hunter2-longer' } }, 'nested');
    logger.info({ req: { headers: { cookie: 'chitthi_session=abc', authorization: 'Bearer xyz' } } }, 'request');

    const out = output();
    expect(out).toContain('db failed'); // the lines were written
    expect(out).not.toContain(DB_PASSWORD);
    expect(out).not.toContain(UNREACHABLE_DB_URL);
    expect(out).not.toContain('hunter2-longer');
    expect(out).not.toContain('chitthi_session=abc');
    expect(out).not.toContain('Bearer xyz');
  });

  it('scrubs any credential URL, even unregistered ones', () => {
    const line = '{"msg":"proxy https://bob:s3cr3t@example.com/x and redis://:pw@cache:6379"}';
    const out = scrubLine(line, []);
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain(':pw@');
    expect(out).toContain('https://[redacted]@example.com/x');
  });

  it('scrubs a registered secret in raw and JSON-escaped form', () => {
    const secret = 'a"b\\c-secret';
    expect(scrubLine(`{"msg":${JSON.stringify(`value ${secret}`)}}`, [secret])).not.toContain('secret');
  });
});
