import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { RealtimeClient } from './client.js';
import { RealtimeContext } from './context.js';

/**
 * One RealtimeClient per signed-in session (the provider is keyed by user id). start/stop are
 * symmetric and restartable, so StrictMode's mount → unmount → mount is harmless.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [client] = useState(() => new RealtimeClient(qc));
  useEffect(() => {
    client.start();
    return () => { client.stop(); };
  }, [client]);
  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}
