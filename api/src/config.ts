import { z } from 'zod';

const DEV_LOGIN_ENVS: readonly string[] = ['development', 'test'];

export function devLoginAllowed(nodeEnv: string): boolean {
  return DEV_LOGIN_ENVS.includes(nodeEnv);
}

/** Unset or empty (the .env.example placeholders) both mean "not configured". */
const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.url().optional());

// Provider endpoints default to the real ones; overrides exist only so tests can point at mock
// providers, and are refused in production.
const ENDPOINT_OVERRIDES = [
  'GOOGLE_ISSUER', 'GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_JWKS_URL',
  'GITHUB_AUTH_URL', 'GITHUB_TOKEN_URL', 'GITHUB_API_URL',
] as const;

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
    // Where browsers reach Chitthi; OAuth redirect URIs are built on it. Defaults to the first WEB_ORIGIN.
    PUBLIC_ORIGIN: optionalUrl,
    // 1 behind exactly one reverse proxy (Caddy) that sets X-Forwarded-For; 0 when serving directly.
    TRUST_PROXY: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
    DEV_LOGIN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    // Sign-in attempts per IP per 10 minutes (default 30). Raised only for end-to-end test runs.
    RATE_LIMIT_AUTH: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(100_000).optional()),
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
    GOOGLE_ISSUER: optionalUrl,
    GOOGLE_AUTH_URL: optionalUrl,
    GOOGLE_TOKEN_URL: optionalUrl,
    GOOGLE_JWKS_URL: optionalUrl,
    GITHUB_AUTH_URL: optionalUrl,
    GITHUB_TOKEN_URL: optionalUrl,
    GITHUB_API_URL: optionalUrl,
  })
  .superRefine((env, ctx) => {
    if (env.DEV_LOGIN && !devLoginAllowed(env.NODE_ENV)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_LOGIN'],
        message: `dev login may only be enabled when NODE_ENV is ${DEV_LOGIN_ENVS.join(' or ')}`,
      });
    }
    if (env.PUBLIC_ORIGIN !== undefined && !env.WEB_ORIGINS.includes(env.PUBLIC_ORIGIN.replace(/\/$/, ''))) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'must be one of WEB_ORIGINS' });
    }
    for (const [id, secret] of [['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']] as const) {
      if ((env[id] === undefined) !== (env[secret] === undefined)) {
        ctx.addIssue({ code: 'custom', path: [secret], message: `set both ${id} and ${secret}, or neither` });
      }
    }
    if (env.NODE_ENV === 'production') {
      for (const key of ENDPOINT_OVERRIDES) {
        if (env[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'endpoint overrides are for tests only' });
      }
    }
  });

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  /** Accepted `iss` values for ID tokens. */
  issuers: string[];
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
};
export type GithubConfig = { clientId: string; clientSecret: string; authUrl: string; tokenUrl: string; apiUrl: string };

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: string;
  webOrigins: string[];
  /** Origin browsers use (no trailing slash); OAuth redirect URIs are `${publicOrigin}/api/auth/…`. */
  publicOrigin: string;
  /** Trust exactly one proxy hop for the client IP (rate limits), or none. */
  trustProxy: boolean;
  devLogin: boolean;
  authLimitPoints: number | undefined;
  google: GoogleConfig | undefined;
  github: GithubConfig | undefined;
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
  const google: GoogleConfig | undefined =
    e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
      ? {
          clientId: e.GOOGLE_CLIENT_ID,
          clientSecret: e.GOOGLE_CLIENT_SECRET,
          issuers: e.GOOGLE_ISSUER ? [e.GOOGLE_ISSUER] : ['https://accounts.google.com', 'accounts.google.com'],
          authUrl: e.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: e.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
          jwksUrl: e.GOOGLE_JWKS_URL ?? 'https://www.googleapis.com/oauth2/v3/certs',
        }
      : undefined;
  const github: GithubConfig | undefined =
    e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET
      ? {
          clientId: e.GITHUB_CLIENT_ID,
          clientSecret: e.GITHUB_CLIENT_SECRET,
          authUrl: e.GITHUB_AUTH_URL ?? 'https://github.com/login/oauth/authorize',
          tokenUrl: e.GITHUB_TOKEN_URL ?? 'https://github.com/login/oauth/access_token',
          apiUrl: e.GITHUB_API_URL ?? 'https://api.github.com',
        }
      : undefined;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    webOrigins: e.WEB_ORIGINS,
    publicOrigin: (e.PUBLIC_ORIGIN ?? e.WEB_ORIGINS[0] ?? '').replace(/\/$/, ''),
    trustProxy: e.TRUST_PROXY,
    devLogin: e.DEV_LOGIN,
    authLimitPoints: e.RATE_LIMIT_AUTH,
    google,
    github,
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
  if (config.google) out.push(config.google.clientSecret);
  if (config.github) out.push(config.github.clientSecret);
  return out;
}
