import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { createRateLimits, type Limits } from '../src/limits.js';
import { SOCKET_PATH } from '../src/realtime/server.js';
import { startApi, type Started, type StartOptions } from '../src/start.js';
import { GENEROUS, type Signed } from './apphelpers.js';
import { captureLogger, testConfig, WEB_ORIGIN } from './helpers.js';

export type TestServer = Started & { lines: string[] };

/** The real API process (HTTP + Socket.IO + LISTEN) on an OS-chosen port, as chitthi_api. */
export async function startTestServer(
  pool: pg.Pool,
  apiUrl: string,
  opts: { limits?: Limits } & Pick<StartOptions, 'realtime' | 'listenerBackoff'> = {},
): Promise<TestServer> {
  const config = testConfig({ DATABASE_URL: apiUrl, DEV_LOGIN: 'true', HOST: '127.0.0.1', PORT: '0' });
  const { logger, lines } = captureLogger(config);
  const rateLimits = createRateLimits(pool, logger, opts.limits ?? GENEROUS, `t${randomBytes(4).toString('hex')}:`);
  const started = await startApi({ config, logger, pool, rateLimits, ...opts });
  await waitUntil(() => started.listener.listening, 5_000, 'listener connected');
  return { ...started, lines };
}

export type ConnectOptions = { origin?: string | null; cookie?: string | null };

/** A real socket.io-client socket for `user`, as a browser on the web origin would open it. */
export function socketFor(server: { url: string }, user: Signed | null, opts: ConnectOptions = {}): Socket {
  const headers: Record<string, string> = {};
  const origin = opts.origin === undefined ? WEB_ORIGIN : opts.origin;
  const cookie = opts.cookie === undefined ? user?.cookie : opts.cookie;
  if (origin !== null) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  return io(server.url, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    extraHeaders: headers,
    reconnection: false,
    forceNew: true,
  });
}

/** Connects and resolves on the server's `ready` (rooms joined); rejects with the connect error. */
export function connected(socket: Socket, timeoutMs = 5_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('timed out waiting for ready')); }, timeoutMs);
    socket.once('ready', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

export async function connect(server: { url: string }, user: Signed): Promise<Socket> {
  return connected(socketFor(server, user));
}

/** Resolves with the first `event` payload matching `pred`. */
export function next<T = unknown>(socket: Socket, event: string, pred: (p: T) => boolean = () => true, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, on);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const on = (p: T) => {
      if (!pred(p)) return;
      clearTimeout(timer);
      socket.off(event, on);
      resolve(p);
    };
    socket.on(event, on);
  });
}

/** Records every payload of `event` from now on. */
export function record<T = unknown>(socket: Socket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (p: T) => seen.push(p));
  return seen;
}

export function disconnected(socket: Socket, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!socket.connected) { resolve('already disconnected'); return; }
    const timer = setTimeout(() => { reject(new Error('timed out waiting for disconnect')); }, timeoutMs);
    socket.once('disconnect', (reason) => { clearTimeout(timer); resolve(reason); });
  });
}

export async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
