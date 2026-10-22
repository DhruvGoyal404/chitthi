import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type SubmitEvent } from 'react';
import { Button, Icon, IconButton } from '../components/ui.js';
import { ACCEPT, formatBytes, looksLikeImage } from '../lib/media.js';
import { codePoints } from './text.js';

const MAX = 4000;
const TYPING_REFRESH_MS = 2_000;

type Props = {
  disabled: boolean;
  disabledReason?: string;
  editing: { body: string } | null;
  onSend: (body: string, files: File[]) => void;
  /** Files chosen to go with the next letter (owned by the chat, so drag-and-drop can add too). */
  files: readonly File[];
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  /** Why the last files were not added (too many, too large), if they weren't. */
  fileError?: string | undefined;
  onSaveEdit: (body: string) => void;
  onCancelEdit: () => void;
  onTyping: (typing: boolean) => void;
};

/**
 * The writing desk: Enter sends, Shift+Enter is a new line. Edit mode reuses it; the parent keys it
 * by the message being edited, so the draft starts from that message and resets afterwards.
 */
export function Composer({ disabled, disabledReason, editing, onSend, onSaveEdit, onCancelEdit, onTyping, files, onAddFiles, onRemoveFile, fileError }: Props) {
  const [draft, setDraft] = useState(editing?.body ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const picker = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, 160))}px`;
  }, [draft]);

  const stopTyping = () => {
    if (lastTyping.current !== 0) {
      lastTyping.current = 0;
      onTyping(false);
    }
  };
  const change = (v: string) => {
    setDraft(v);
    if (editing) return;
    if (v.trim() === '') {
      stopTyping();
      return;
    }
    const now = Date.now();
    if (now - lastTyping.current > TYPING_REFRESH_MS) {
      lastTyping.current = now;
      onTyping(true);
    }
  };

  const length = codePoints(draft);
  const withFiles = !editing && files.length > 0;
  const valid = (draft.trim() !== '' || withFiles) && length <= MAX;
  const submit = () => {
    if (!valid || disabled) return;
    if (editing) onSaveEdit(draft);
    else onSend(draft, [...files]);
    stopTyping();
    setDraft('');
  };
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit();
  };
  // Pasting an image (a screenshot, a copied photo) attaches it.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (editing || e.clipboardData.files.length === 0) return;
    e.preventDefault();
    onAddFiles([...e.clipboardData.files]);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && editing) {
      onCancelEdit();
    }
  };

  return (
    <form onSubmit={onSubmit} className="shrink-0 border-t border-paper-edge bg-paper-deep px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2" aria-label="Write a message">
      {editing && (
        <div className="mb-1 flex items-center justify-between px-1 text-xs text-ink-soft">
          <span>Editing message</span>
          <IconButton label="Cancel editing" className="h-8 w-8" onClick={onCancelEdit}><Icon.Close width={16} height={16} /></IconButton>
        </div>
      )}
      {!editing && files.length > 0 && <Tray files={files} onRemove={onRemoveFile} />}
      {fileError && <p role="alert" className="px-1 pb-1 text-xs text-stamp">{fileError}</p>}
      {disabled ? (
        <p className="px-2 py-3 text-center text-sm text-ink-soft">{disabledReason}</p>
      ) : (
        <div className="flex items-end gap-2">
          {!editing && (
            <>
              <IconButton label="Attach photos or files" className="shrink-0" onClick={() => { picker.current?.click(); }}><Icon.Paperclip /></IconButton>
              <input ref={picker} type="file" multiple accept={ACCEPT} className="hidden" aria-hidden tabIndex={-1} data-testid="file-picker"
                onChange={(e) => { onAddFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </>
          )}
          <label htmlFor="composer" className="sr-only">Message</label>
          <textarea id="composer" ref={ref} rows={1} autoFocus={editing !== null} value={draft} onChange={(e) => { change(e.target.value); }} onKeyDown={onKeyDown} onBlur={stopTyping} onPaste={onPaste}
            placeholder={withFiles ? 'Add a caption…' : 'Write a letter…'} aria-describedby={length > MAX - 200 ? 'composer-count' : undefined}
            className="max-h-40 min-h-11 flex-1 resize-none rounded-md border border-paper-edge bg-sheet px-3 py-2.5 font-[family-name:var(--font-letter)] text-ink placeholder:text-ink-soft" />
          <Button type="submit" disabled={!valid} aria-label={editing ? 'Save edit' : 'Send'} className="h-11 w-11 shrink-0 px-0">
            {editing ? <Icon.Check /> : <Icon.Send />}
          </Button>
        </div>
      )}
      {length > MAX - 200 && (
        <p id="composer-count" className={`px-1 pt-1 text-right text-xs ${length > MAX ? 'text-stamp' : 'text-ink-soft'}`}>
          {length} / {MAX}
        </p>
      )}
    </form>
  );
}

/** Files waiting to be sent: a small preview of each, with a way to take it out again. */
function Tray({ files, onRemove }: { files: readonly File[]; onRemove: (index: number) => void }) {
  // One blob: URL per staged image, released when the files change or the tray goes away.
  const urls = useMemo(() => files.map((f) => (looksLikeImage(f) ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => { for (const u of urls) if (u) URL.revokeObjectURL(u); }, [urls]);
  return (
    <ul className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Attachments to send">
      {files.map((f, i) => (
        <li key={`${f.name}-${String(f.size)}-${String(i)}`} className="relative flex w-24 shrink-0 flex-col items-center gap-1 rounded-sm border border-paper-edge bg-sheet p-1">
          {urls[i]
            ? <img src={urls[i] ?? undefined} alt="" className="h-16 w-full rounded-sm object-cover" />
            : <span className="flex h-16 w-full items-center justify-center text-ink-soft"><Icon.File width={28} height={28} /></span>}
          <span className="w-full truncate text-center text-[0.7rem] text-ink" title={f.name}>{f.name}</span>
          <span className="text-[0.65rem] text-ink-soft">{formatBytes(f.size)}</span>
          <button type="button" onClick={() => { onRemove(i); }} aria-label={`Remove ${f.name}`}
            className="absolute -right-1 -top-1 inline-flex h-7 w-7 items-center justify-center rounded-full border border-paper-edge bg-sheet text-ink">
            <Icon.Close width={12} height={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}
