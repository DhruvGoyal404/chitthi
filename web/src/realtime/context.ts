import { createContext } from 'react';
import type { RealtimeClient } from './client.js';

export const RealtimeContext = createContext<RealtimeClient | null>(null);
