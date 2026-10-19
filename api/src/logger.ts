import { pino, type DestinationStream, type Logger } from 'pino';

// scheme://user:password@ with any scheme: connection strings, proxied URLs, webhook URLs.
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'/@:]*:[^\s"'/@]*@/gi;

const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'databaseUrl',
  '*.databaseUrl',
  'connectionString',
  '*.connectionString',
  'DATABASE_URL',
  '*.DATABASE_URL',
];

/** Rewrites one serialized log line so that no credential URL or registered secret survives. */
export function scrubLine(line: string, secrets: readonly string[]): string {
  let out = line.replace(CREDENTIAL_URL, '$1://[redacted]@');
  for (const secret of secrets) {
    if (secret.length < 4) continue; // too short to scrub without mangling ordinary text
    // A secret can appear raw or JSON-escaped inside the serialized line.
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      out = out.split(form).join('[redacted]');
    }
  }
  return out;
}

export type LoggerOptions = {
  /** Exact values to scrub from every line (DATABASE_URL, its password, client secrets…). */
  secrets?: readonly string[];
  /** Defaults to stdout. */
  destination?: DestinationStream;
};

/**
 * Two layers: pino's path redaction for known fields, then a last-line scrubber over the
 * serialized output, which also catches secrets embedded in error messages and stacks.
 */
export function createLogger(level: string, { secrets = [], destination = process.stdout }: LoggerOptions = {}): Logger {
  const scrubbing: DestinationStream = {
    write(line: string) {
      destination.write(scrubLine(line, secrets));
    },
  };
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, scrubbing);
}
