import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './lib/api.js';
import type { User } from './lib/types.js';

/** The signed-in user, or null when signed out. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api<{ user: User }>('/me')).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<undefined>('/dev/logout', { method: 'POST' }),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(['me'], null);
    },
  });
}
