import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './lib/api.js';
import type { Me, Providers } from './lib/types.js';

/** The signed-in user, or null when signed out. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api<{ user: Me }>('/me')).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });
}

/** Which sign-in options this server offers. */
export function useProviders() {
  return useQuery({ queryKey: ['providers'], queryFn: () => api<Providers>('/auth/providers'), staleTime: Infinity });
}

/** Signs this browser out, or (everywhere) every session of the account; open sockets are closed by the server. */
export function useSignOut(everywhere = false) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<unknown>(everywhere ? '/auth/logout-all' : '/auth/logout', { method: 'POST' }),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(['me'], null);
    },
  });
}
