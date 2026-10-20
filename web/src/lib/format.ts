const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const DAY = 24 * 60 * 60 * 1000;

/** "14:05", "Tue", or "3 Oct" depending on how long ago. */
export function shortWhen(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  const age = now - t;
  if (age < DAY && new Date(t).getDate() === new Date(now).getDate()) return time.format(t);
  if (age < 6 * DAY) return weekday.format(t);
  return date.format(t);
}

export const clock = (iso: string) => time.format(new Date(iso));
export const fullWhen = (iso: string) => full.format(new Date(iso));

/** "online", "last seen 14:05", "last seen 3 Oct". */
export function lastSeenPhrase(p: { online: boolean; lastSeenAt: string | null } | undefined): string | null {
  if (!p) return null;
  if (p.online) return 'online';
  return p.lastSeenAt ? `last seen ${shortWhen(p.lastSeenAt)}` : null;
}
