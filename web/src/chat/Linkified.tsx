import { linkify } from './linkify.js';

/**
 * Message text as React text nodes; only http(s) URLs become links, opened in a new tab with
 * rel="noopener noreferrer". Never HTML: no innerHTML, no markdown.
 */
export function Linkified({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((t, i) =>
        t.kind === 'link' ? (
          <a key={i} href={t.href} target="_blank" rel="noopener noreferrer" className="break-all text-seal underline underline-offset-2">
            {t.text}
          </a>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </>
  );
}
