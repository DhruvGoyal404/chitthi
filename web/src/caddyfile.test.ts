import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WEB_CSP } from '../vite.config';

// The production page gets its CSP twice: as a <meta> tag from the build and as a header from the
// web image's Caddy, which alone can add frame-ancestors. The two must never drift apart.
const caddyfile = readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8');

describe('web image Caddyfile', () => {
  it("sends the build's CSP as a header, plus frame-ancestors 'none'", () => {
    const headers = [...caddyfile.matchAll(/^\s*Content-Security-Policy "([^"]*)"/gm)].map((m) => m[1]);
    expect(headers).toEqual([`${WEB_CSP}; frame-ancestors 'none'`]);
  });

  it('never administrable, never trying to obtain certificates', () => {
    expect(caddyfile).toMatch(/^\s*admin off$/m);
    expect(caddyfile).toMatch(/^\s*auto_https off$/m);
  });
});
