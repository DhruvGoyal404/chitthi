import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/ui.js';
import { attachmentUrl, formatBytes } from '../lib/media.js';
import type { Attachment } from '../lib/types.js';
import type { PendingFile } from './outbox.js';

const SINGLE_MAX_W = 260;
const SINGLE_MAX_H = 320;

/**
 * A photo's box is sized from its stored width and height before anything loads, so the
 * virtualized list never jumps: the placeholder fills it (blurred), then the thumbnail fades in.
 */
function boxSize(width: number, height: number, single: boolean): { width: number; height: number } {
  if (!single) return { width: 124, height: 124 };
  const scale = Math.min(1, SINGLE_MAX_W / width, SINGLE_MAX_H / height);
  return { width: Math.max(60, Math.round(width * scale)), height: Math.max(60, Math.round(height * scale)) };
}

function Photo({ a, single, onOpen }: { a: Attachment; single: boolean; onOpen: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const thumb = attachmentUrl(a.id, true);
  const size = boxSize(a.width ?? 1, a.height ?? 1, single);
  return (
    <button type="button" onClick={onOpen} aria-label={`Open photo ${a.name}`}
      className="relative block overflow-hidden rounded-sm border border-paper-edge bg-paper-deep"
      style={{ width: size.width, height: size.height }}>
      {a.placeholder && (
        <span aria-hidden className="absolute inset-0 scale-110 bg-cover bg-center blur-md" style={{ backgroundImage: `url("${a.placeholder}")` }} />
      )}
      {thumb && (
        <img src={thumb} alt="" loading="lazy" decoding="async" onLoad={() => { setLoaded(true); }}
          className={`relative h-full w-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`} />
      )}
    </button>
  );
}

function FileChip({ a }: { a: Attachment }) {
  const url = attachmentUrl(a.id);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-sm border border-paper-edge bg-sheet px-2 py-1.5">
      <Icon.File width={20} height={20} className="shrink-0 text-ink-soft" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{a.name}</span>
        <span className="block text-xs text-ink-soft">{formatBytes(a.size)}</span>
      </span>
      {url && (
        <a href={url} download={a.name} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink hover:bg-paper-deep" aria-label={`Download ${a.name}`}>
          <Icon.Download width={18} height={18} />
        </a>
      )}
    </div>
  );
}

/** Full-size photo in a native modal dialog (focus trap, Esc and the backdrop come with it). */
function Lightbox({ a, onClose }: { a: Attachment; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const url = attachmentUrl(a.id);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={a.name}
      onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close(); }}
      className="m-auto max-h-[92vh] max-w-[94vw] rounded-sm bg-sheet p-2 text-ink shadow-xl backdrop:bg-black/70">
      <div className="mb-2 flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate px-1 text-sm">{a.name}</p>
        {url && (
          <a href={url} download={a.name} className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-paper-deep" aria-label={`Download ${a.name}`}>
            <Icon.Download width={18} height={18} />
          </a>
        )}
        <button type="button" onClick={() => { ref.current?.close(); }} aria-label="Close photo"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-paper-deep">
          <Icon.Close width={18} height={18} />
        </button>
      </div>
      {url && <img src={url} alt={a.name} className="mx-auto max-h-[80vh] max-w-full object-contain" style={{ aspectRatio: `${String(a.width ?? 1)} / ${String(a.height ?? 1)}` }} />}
    </dialog>
  );
}

/** A stored message's attachments: photos in a grid, files as chips. */
export function Attachments({ items }: { items: readonly Attachment[] }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  const photos = items.filter((a) => a.kind === 'image');
  const files = items.filter((a) => a.kind === 'file');
  return (
    <div className="mb-1 space-y-1.5">
      {photos.length > 0 && (
        <div className={photos.length === 1 ? '' : 'grid grid-cols-2 gap-1'}>
          {photos.map((a) => <Photo key={a.id} a={a} single={photos.length === 1} onOpen={() => { setOpen(a); }} />)}
        </div>
      )}
      {files.map((a) => <FileChip key={a.id} a={a} />)}
      {open && <Lightbox a={open} onClose={() => { setOpen(null); }} />}
    </div>
  );
}

/** A pending message's files: local previews with upload progress. */
export function PendingFiles({ files }: { files: readonly PendingFile[] }) {
  return (
    <ul className="mb-1 space-y-1.5" aria-label="Attachments being sent">
      {files.map((f) => (
        <li key={f.localId} className="flex items-center gap-2 rounded-sm border border-paper-edge bg-sheet p-1.5">
          {f.previewUrl
            ? <img src={f.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded-sm object-cover" />
            : <Icon.File width={20} height={20} className="mx-1 shrink-0 text-ink-soft" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-ink">{f.name}</span>
            {f.status === 'failed'
              ? <span className="block text-xs text-stamp">{f.error ?? "Couldn't upload."}</span>
              : (
                <progress className="block h-1.5 w-full" max={1} value={f.status === 'done' ? 1 : f.progress}
                  aria-label={`Uploading ${f.name}`} />
              )}
          </span>
        </li>
      ))}
    </ul>
  );
}
