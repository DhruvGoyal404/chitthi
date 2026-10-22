/** Extensions a download may carry, per stored type; the first is added when none matches. */
const EXTENSIONS = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'application/zip': ['zip'],
  'text/plain': ['txt'],
} as const;

export type StoredMime = keyof typeof EXTENSIONS;
const MAX = 200;

/**
 * The name shown in the chat and offered on download. Never used on disk. Takes only the last
 * path segment, drops control and bidi-override characters (so "photo‮gnp.exe" can't pose
 * as a PNG), and forces an extension that matches what the file really is: "page.html" stored as
 * text downloads as "page.html.txt", never as .html.
 */
export function displayName(raw: string | undefined, mime: StoredMime): string {
  let name = (raw ?? '').split(/[\\/]/).pop() ?? '';
  name = name
    .normalize('NFC')
    .replace(/[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu, '')
    .trim()
    .replace(/^\.+/, '');
  const exts: readonly string[] = EXTENSIONS[mime];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  const matches = exts.includes(ext.toLowerCase());
  let stem = matches ? name.slice(0, dot) : name;
  const finalExt = matches ? ext : (exts[0] ?? 'bin'); // the sender's casing when it already fits
  stem = stem.trim() || 'file';
  const room = MAX - finalExt.length - 1;
  // Cut on grapheme boundaries, so an emoji or a conjunct is never split in half.
  let cut = '';
  for (const { segment } of new Intl.Segmenter().segment(stem)) {
    if (cut.length + segment.length > room) break;
    cut += segment;
  }
  return `${cut.trim() || 'file'}.${finalExt}`;
}
