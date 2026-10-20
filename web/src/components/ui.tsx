import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { title?: string };

function Svg({ title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} {...rest}>
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export const Icon = {
  Back: (p: IconProps) => <Svg {...p}><path d="M15 18l-6-6 6-6" /></Svg>,
  Plus: (p: IconProps) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>,
  Send: (p: IconProps) => <Svg {...p}><path d="M4 12l16-8-6 16-2.5-6.5L4 12z" /></Svg>,
  Group: (p: IconProps) => <Svg {...p}><circle cx="9" cy="8" r="3" /><path d="M3 19c0-3 3-5 6-5s6 2 6 5" /><path d="M16 5a3 3 0 010 6M21 19c0-2.5-1.8-4.3-4-4.8" /></Svg>,
  Settings: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" /></Svg>,
  Info: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></Svg>,
  Clock: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2" /></Svg>,
  Check: (p: IconProps) => <Svg {...p}><path d="M5 12.5l4 4 10-10" /></Svg>,
  CheckCheck: (p: IconProps) => <Svg {...p}><path d="M2 12.5l4 4 9-9" /><path d="M10 15.5l1 1 9-9" /></Svg>,
  Alert: (p: IconProps) => <Svg {...p}><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v4M12 17v.5" /></Svg>,
  Retry: (p: IconProps) => <Svg {...p}><path d="M4 12a8 8 0 0114-5.3L20 9M20 4v5h-5" /><path d="M20 12a8 8 0 01-14 5.3L4 15M4 20v-5h5" /></Svg>,
  Edit: (p: IconProps) => <Svg {...p}><path d="M4 20h4L19 9l-4-4L4 16v4z" /></Svg>,
  Trash: (p: IconProps) => <Svg {...p}><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" /></Svg>,
  Close: (p: IconProps) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>,
  Search: (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></Svg>,
  Moon: (p: IconProps) => <Svg {...p}><path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" /></Svg>,
  Sun: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" /></Svg>,
  Letter: (p: IconProps) => <Svg {...p}><rect x="3" y="6" width="18" height="12" rx="1.5" /><path d="M3 7l9 6 9-6" /></Svg>,
};

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

/** A postage-stamp avatar: initials on a perforated stamp. */
export function Avatar({ name, size = 40, group = false }: { name: string; size?: number; group?: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex shrink-0 items-center justify-center rounded-[4px] border-2 border-dashed border-paper-edge bg-sheet font-semibold text-ink"
      style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {group ? <Icon.Group width={size * 0.5} height={size * 0.5} /> : initials(name)}
    </span>
  );
}

/** Online dot with a text alternative (never colour alone). */
export function PresenceDot({ online, className = '' }: { online: boolean; className?: string }) {
  return (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ring-2 ring-paper ${online ? 'bg-seal' : 'bg-paper-edge'} ${className}`}
      role="img" aria-label={online ? 'online' : 'offline'} />
  );
}

export function Button({ variant = 'primary', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-ink text-paper hover:opacity-90',
    ghost: 'border border-paper-edge text-ink hover:bg-paper-deep',
    danger: 'border border-stamp text-stamp hover:bg-paper-deep',
  }[variant];
  return <button type="button" className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium disabled:opacity-60 ${styles} ${className}`} {...rest} />;
}

export function IconButton({ label, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-ink hover:bg-paper-deep ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Field({ label, hint, error, id, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | undefined; id: string }) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-ink">{label}</label>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy}
        className="block min-h-11 w-full rounded-md border border-paper-edge bg-sheet px-3 text-ink placeholder:text-ink-soft" {...rest} />
      {hint && <p id={`${id}-hint`} className="text-xs text-ink-soft">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-sm text-stamp">{error}</p>}
    </div>
  );
}

/** Screen header: back button on mobile, title, actions. */
export function TopBar({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="shrink-0 bg-paper-deep">
      <div className="flex min-h-14 items-center gap-2 px-2">
        {back}
        <div className="min-w-0 flex-1 px-1">
          <h1 className="truncate text-base font-semibold text-ink">{title}</h1>
          {subtitle && <p className="truncate text-xs text-ink-soft">{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className="perforated" aria-hidden />
    </header>
  );
}
