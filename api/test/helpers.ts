import type { DestinationStream } from 'pino';
import { loadConfig, secretsOf, type Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';

export const WEB_ORIGIN = 'http://localhost:5175';
/** A recognisable password so tests can assert it never shows up in output. */
export const DB_PASSWORD = 'pw-Never-Log-Me-7f3a';
/** Port 1 refuses connections immediately: a database that is down, without waiting on timeouts. */
export const UNREACHABLE_DB_URL = `postgres://chitthi:${DB_PASSWORD}@127.0.0.1:1/chitthi`;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: UNREACHABLE_DB_URL,
    WEB_ORIGINS: WEB_ORIGIN,
    LOG_LEVEL: 'info',
    ...overrides,
  });
}

/** A logger that writes to memory, with the config's secrets registered like server.ts does. */
export function captureLogger(config: Config) {
  const lines: string[] = [];
  const destination: DestinationStream = { write: (line: string) => { lines.push(line); } };
  const logger = createLogger(config.logLevel, { secrets: secretsOf(config), destination });
  return { logger, lines, output: () => lines.join('') };
}
