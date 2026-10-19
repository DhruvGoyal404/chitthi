import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, Route, Routes } from 'react-router';
import { api, ApiError } from './lib/api.js';

type Health = { status: 'ok' | 'degraded'; db: 'ok' | 'unreachable' };

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-paper-deep bg-paper/80">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <span aria-hidden className="inline-block h-6 w-5 rounded-sm bg-stamp" />
          <Link to="/" className="text-lg font-semibold tracking-tight">Chitthi</Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>
    </div>
  );
}

function HealthBadge() {
  const health = useQuery({
    queryKey: ['health'],
    // 503 still carries a health body; show it rather than a bare error.
    queryFn: async () => {
      try {
        return await api<Health>('/health');
      } catch (e) {
        if (e instanceof ApiError && e.status === 503) return { status: 'degraded', db: 'unreachable' };
        throw e;
      }
    },
  });
  const label = health.isPending ? 'checking…' : health.isError ? 'API unreachable' : `API ${health.data.status}, database ${health.data.db}`;
  const ok = health.data?.status === 'ok';
  return (
    <p className="inline-flex items-center gap-2 rounded-full border border-paper-deep bg-white/60 px-3 py-1 text-sm text-ink-soft">
      <span aria-hidden className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-600' : 'bg-stamp'}`} />
      {label}
    </p>
  );
}

function Home() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Letters that arrive in order.</h1>
      <p className="max-w-prose text-ink-soft">
        Chitthi is a real-time chat app under construction. Messages are not end-to-end encrypted: the server can read them.
      </p>
      <HealthBadge />
    </section>
  );
}

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="*" element={<p>Not found. <Link className="underline" to="/">Home</Link></p>} />
      </Routes>
    </Shell>
  );
}
