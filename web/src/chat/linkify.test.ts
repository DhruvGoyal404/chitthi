import { describe, expect, it } from 'vitest';
import { linkify } from './linkify.js';

const links = (s: string) => linkify(s).flatMap((t) => (t.kind === 'link' ? [t.href] : []));
const roundTrip = (s: string) => linkify(s).map((t) => t.text).join('');

describe('linkify', () => {
  it('links http and https only', () => {
    expect(links('see https://example.com/a and http://example.org')).toEqual(['https://example.com/a', 'http://example.org/']);
  });

  it('never links dangerous or schemeless URLs', () => {
    for (const s of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'www.example.com',
      'mailto:a@b.c',
      '//evil.example/path',
      '<a href="javascript:alert(1)">x</a>',
      'https://',
      'http:///nohost',
    ]) {
      expect(links(s), s).toEqual([]);
    }
  });

  it('does not let a URL swallow markup or quotes', () => {
    expect(links('<a href="https://evil.example/x">tap</a>')).toEqual(['https://evil.example/x']);
    expect(links('https://example.com/ok?a=1&b=<2>')).toEqual(['https://example.com/ok?a=1&b=']);
    expect(links('"https://example.com/q"')).toEqual(['https://example.com/q']);
  });

  it('leaves sentence punctuation outside the link, keeping balanced brackets', () => {
    expect(links('Go to https://example.com/path.')).toEqual(['https://example.com/path']);
    expect(links('(see https://example.com/x)')).toEqual(['https://example.com/x']);
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  it('never loses or reorders text', () => {
    for (const s of ['plain', 'a https://x.example b http://y.example/c?d=e#f, end.', '<script>alert(1)</script>', '😀 https://例え.jp/パス 😀']) {
      expect(roundTrip(s)).toBe(s);
    }
  });
});
