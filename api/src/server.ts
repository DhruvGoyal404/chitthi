import { createApp } from './app.js';
import { ConfigError, loadConfig, secretsOf, type Config } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger(config.logLevel, { secrets: secretsOf(config) });
const pool = createPool(config.databaseUrl, logger);
const app = createApp({ config, logger, pool });

// Last line of defence: log and keep serving. Express 5 already routes rejected handler
// promises to the error handler, so reaching these means a bug outside a request.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection');
});

const server = app.listen(config.port, config.host, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  logger.info({ host: config.host, port, nodeEnv: config.nodeEnv }, 'api listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
