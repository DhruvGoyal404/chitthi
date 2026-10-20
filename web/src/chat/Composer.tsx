import { useLayoutEffect, useRef, useState, type KeyboardEvent, type SubmitEvent } from 'react';
import { Button, Icon, IconButton } from '../components/ui.js';
import { codePoints } from './text.js';

const MAX = 4000;
const TYPING_REFRESH_MS = 2_000;

type Props = {
  disabled: boolean;
  disabledReason?: string;
  editing: { body: string } | null;
  onSend: (body: string) => void;
  onSaveEdit: (body: string) => void;
  onCancelEdit: () => void;
  onTyping: (typing: boolean) => void;
};

/**
 * The writing desk: Enter sends, Shift+Enter is a new line. Edit mode reuses it; the parent keys it
 * by the message being edited, so the draft starts from that message and resets afterwards.
 */
export function Composer({ disabled, disabledReason, editing, onSend, onSaveEdit, onCancelEdit, onTyping }: Props) {
  const [draft, setDraft] = useState(editing?.body ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);

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
  const valid = draft.trim() !== '' && length <= MAX;
  const submit = () => {
    if (!valid || disabled) return;
    if (editing) onSaveEdit(draft);
    else onSend(draft);
    stopTyping();
    setDraft('');
  };
  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit();
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
      {disabled ? (
        <p className="px-2 py-3 text-center text-sm text-ink-soft">{disabledReason}</p>
      ) : (
        <div className="flex items-end gap-2">
          <label htmlFor="composer" className="sr-only">Message</label>
          <textarea id="composer" ref={ref} rows={1} autoFocus={editing !== null} value={draft} onChange={(e) => { change(e.target.value); }} onKeyDown={onKeyDown} onBlur={stopTyping}
            placeholder="Write a letter…" aria-describedby={length > MAX - 200 ? 'composer-count' : undefined}
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
