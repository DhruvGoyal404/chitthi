export type Variant = 'primary' | 'ghost' | 'danger';

/** Button looks, also for links that act as buttons (full-page navigations to the API). */
export function buttonClass(variant: Variant = 'primary', className = ''): string {
  const styles = {
    primary: 'bg-ink text-paper hover:opacity-90',
    ghost: 'border border-paper-edge text-ink hover:bg-paper-deep',
    danger: 'border border-stamp text-stamp hover:bg-paper-deep',
  }[variant];
  return `inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium disabled:opacity-60 ${styles} ${className}`;
}
