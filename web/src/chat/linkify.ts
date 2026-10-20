export type Token = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

// Candidate URLs: an explicit http(s) scheme, then non-space characters. Anything else (javascript:,
// data:, www.example.com without a scheme, mailto:) is left as plain text.
// A third slash ("http:///x") is rejected: the URL parser would quietly retarget it.
const CANDIDATE = /\bhttps?:\/\/(?!\/)[^\s<>"'`]+/gi;
// Punctuation that usually ends a sentence rather than a URL.
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * Splits message text into text and link tokens. Only http/https URLs that parse are links; the
 * href is the parsed, normalised URL. Rendering uses React text nodes for everything, so no part
 * of a message is ever interpreted as HTML.
 */
export function linkify(text: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    let candidate = match[0];
    const start = match.index;
    // Keep a closing bracket only if the URL itself opened one ("…/wiki/Foo_(bar)").
    const trail = TRAILING.exec(candidate)?.[0] ?? '';
    if (trail) {
      const opens = (candidate.match(/\(/g) ?? []).length;
      const closes = (candidate.match(/\)/g) ?? []).length;
      const trimmed = trail === ')' && opens >= closes ? '' : trail;
      candidate = candidate.slice(0, candidate.length - trimmed.length);
    }
    let href: string | null = null;
    try {
      const url = new URL(candidate);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '') href = url.href;
    } catch {
      href = null;
    }
    if (!href) continue;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'link', text: candidate, href });
    last = start + candidate.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}
