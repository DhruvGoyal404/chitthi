import { useState } from 'react';
import { Avatar, Field, Icon } from '../components/ui.js';
import { ApiError } from '../lib/api.js';
import type { User } from '../lib/types.js';
import { useUserSearch } from '../queries.js';

/** Handle search that offers people to add; `exclude` hides people already chosen or present. */
export function MemberPicker({ onPick, exclude, label = 'Add people by handle' }: { onPick: (u: User) => void; exclude: ReadonlySet<string>; label?: string }) {
  const [q, setQ] = useState('');
  const results = useUserSearch(q);
  const shown = results.data?.filter((u) => !exclude.has(u.id)) ?? [];
  return (
    <div className="space-y-2">
      <Field id="member-search" label={label} type="search" value={q} autoComplete="off" autoCapitalize="none" spellCheck={false}
        hint="At least 3 characters." onChange={(e) => { setQ(e.target.value); }} />
      {results.isError && <p role="alert" className="text-sm text-stamp">{results.error instanceof ApiError ? results.error.message : 'Search failed. Try again.'}</p>}
      <ul className="space-y-1" aria-live="polite">
        {shown.map((u) => (
          <li key={u.id}>
            <button type="button" onClick={() => { onPick(u); setQ(''); }}
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-paper-deep">
              <Avatar name={u.displayName} src={u.avatarUrl} size={32} />
              <span className="min-w-0 flex-1 truncate text-ink">{u.displayName} <span className="text-ink-soft">@{u.handle}</span></span>
              <Icon.Plus className="text-ink-soft" />
              <span className="sr-only">Add {u.displayName}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
