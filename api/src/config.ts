import { z } from 'zod';

const DEV_LOGIN_ENVS: readonly string[] = ['development', 'test'];

export function devLoginAllowed(nodeEnv: string): boolean {
  return DEV_LOGIN_ENVS.includes(nodeEnv);
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(8082),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Comma-separated origins allowed to send state-changing requests and open WebSockets.
    WEB_ORIGINS: z
      .string()
      .default('http://localhost:5175')
      .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean))
      .pipe(z.array(z.url()).min(1)),
    DEV_LOGIN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    // Sign-in attempts per IP per 10 minutes (default 30). Raised only for end-to-end test runs.
    RATE_LIMIT_AUTH: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(100_000).optional()),
  })
  .superRefine((env, ctx) => {
    if (env.DEV_LOGIN && !devLoginAllowed(env.NODE_ENV)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_LOGIN'],
        message: `dev login may only be enabled when NODE_ENV is ${DEV_LOGIN_ENVS.join(' or ')}`,
      });
    }
  });

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: string;
  webOrigins: string[];
  devLogin: boolean;
  authLimitPoints: number | undefined;
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Validates the environment once at startup. Messages name keys only, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    webOrigins: e.WEB_ORIGINS,
    devLogin: e.DEV_LOGIN,
    authLimitPoints: e.RATE_LIMIT_AUTH,
  };
}

/** Values that must never reach a log line, in every form they could appear in. */
export function secretsOf(config: Config): string[] {
  const out = [config.databaseUrl];
  try {
    const url = new URL(config.databaseUrl);
    if (url.password) out.push(url.password, decodeURIComponent(url.password));
  } catch {
    // DATABASE_URL was validated as a URL; nothing more to extract.
  }
  return out;
}
