/**
 * What an upload really is, from its bytes. The client's Content-Type and file name are never
 * consulted. Allowlist: JPEG, PNG, WebP, GIF (images; GIF must be static and is re-encoded to
 * PNG), PDF, ZIP and plain UTF-8 text (files). Everything else, notably HTML and SVG, is refused.
 */
export type Detected =
  | { kind: 'image'; format: 'jpeg' | 'png' | 'webp' | 'gif' }
  | { kind: 'file'; mime: 'application/pdf' | 'application/zip' | 'text/plain' };

/** Bytes needed to decide (the longest signature is RIFF....WEBP). */
export const SNIFF_BYTES = 12;

const startsWith = (buf: Buffer, sig: readonly number[], at = 0) => sig.every((b, i) => buf[at + i] === b);
const ascii = (s: string): number[] => Array.from(Buffer.from(s, 'latin1'));

/**
 * Decides from the first bytes. `undefined` means "not one of ours" (refuse); text is the
 * fallback only for content that doesn't start like markup, and must then pass TextGuard.
 */
export function sniff(head: Buffer): Detected | undefined {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', format: 'jpeg' };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', format: 'png' };
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return { kind: 'image', format: 'webp' };
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return { kind: 'image', format: 'gif' };
  if (startsWith(head, ascii('%PDF-'))) return { kind: 'file', mime: 'application/pdf' };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return { kind: 'file', mime: 'application/zip' };
  return looksLikeText(head) ? { kind: 'file', mime: 'text/plain' } : undefined;
}

const BOM = [0xef, 0xbb, 0xbf];

/**
 * The start of a plain-text file: no binary bytes, and not markup. Anything whose first
 * non-whitespace character is "<" is refused, which covers every HTML, SVG and XML document
 * (browsers' content sniffing keys on exactly that start), even though it is served as text.
 */
function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;
  let i = startsWith(head, BOM) ? 3 : 0;
  for (const b of head.subarray(i)) if (isForbiddenControl(b)) return false;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x0c)) i++;
  return head[i] !== 0x3c; // '<'
}

/** C0 controls other than tab, newline, form feed and carriage return (and DEL). */
const isForbiddenControl = (b: number) => (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) || b === 0x7f;

export class NotTextError extends Error {}

/**
 * Checks a whole text upload as it streams: strict UTF-8 (a fatal decoder, so a sequence split
 * across chunks is fine and an invalid one is refused) and no forbidden control bytes anywhere.
 */
export class TextGuard {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  /** Still inside the leading BOM/whitespace (the markup check needs the first real character). */
  private leading = true;
  private offset = 0;

  check(chunk: Buffer): void {
    for (const b of chunk) {
      if (isForbiddenControl(b)) throw new NotTextError('binary content in a text file');
      if (this.leading) {
        const inBom = this.offset < 3 && b === BOM[this.offset];
        if (b === 0x3c) throw new NotTextError('starts like markup');
        if (!inBom && b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) this.leading = false;
      }
      this.offset++;
    }
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      throw new NotTextError('not valid UTF-8');
    }
  }

  /** At the end: the last sequence must be complete, and the file must have some content. */
  finish(): void {
    try {
      this.decoder.decode();
    } catch {
      throw new NotTextError('not valid UTF-8');
    }
    if (this.leading) throw new NotTextError('empty or only whitespace');
  }
}
