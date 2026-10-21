import { performance } from 'node:perf_hooks';

/**
 * Where the time of one request goes, stage by stage (each stage = time since the previous
 * mark; repeated stages add up). Sent back as a Server-Timing header, so a client or a load test
 * can see it without any log scraping.
 */
export class StageTimer {
  readonly stages: Record<string, number> = {};
  private last = performance.now();
  private readonly start = this.last;

  mark(stage: string): void {
    const now = performance.now();
    this.stages[stage] = (this.stages[stage] ?? 0) + (now - this.last);
    this.last = now;
  }

  serverTiming(): string {
    const parts = Object.entries(this.stages).map(([name, ms]) => `${name};dur=${ms.toFixed(2)}`);
    return [...parts, `total;dur=${(performance.now() - this.start).toFixed(2)}`].join(', ');
  }
}

/**
 * One send from start to fan-out: the REST stages, then (same process) how long until the
 * NOTIFY arrived, how long it waited in the ordered queue, the row read and the emit. Kept only
 * for the most recent sends, in memory, for tests and diagnostics; never persisted or logged
 * with content (ids and durations only).
 */
export type SendTrace = { messageId: string; rest: Record<string, number>; notifyMs: number; queueMs: number; readMs: number; emitMs: number; emittedAt: number };

type RestHalf = { committedAt: number; rest: Record<string, number> };
type FanoutHalf = { receivedAt: number; startedAt: number; readAt: number; emittedAt: number };

const MAX = 2_000;
const halves = new Map<string, { rest?: RestHalf; fanout?: FanoutHalf }>();
const traces: SendTrace[] = [];

function settle(messageId: string): void {
  const h = halves.get(messageId);
  if (!h?.rest || !h.fanout) return;
  halves.delete(messageId);
  const { rest, fanout } = h;
  traces.push({
    messageId,
    rest: rest.rest,
    // Can be slightly negative: the NOTIFY may reach the listener before the COMMIT reply is processed.
    notifyMs: fanout.receivedAt - rest.committedAt,
    queueMs: fanout.startedAt - fanout.receivedAt,
    readMs: fanout.readAt - fanout.startedAt,
    emitMs: fanout.emittedAt - fanout.readAt,
    emittedAt: fanout.emittedAt,
  });
  if (traces.length > MAX) traces.splice(0, traces.length - MAX);
}

function half(messageId: string) {
  let h = halves.get(messageId);
  if (!h) {
    h = {};
    halves.set(messageId, h);
    // Halves that never pair up (a send whose fan-out had no recipients) must not pile up.
    if (halves.size > MAX) {
      const oldest = halves.keys().next().value;
      if (oldest !== undefined) halves.delete(oldest);
    }
  }
  return h;
}

export function traceCommit(messageId: string, rest: Record<string, number>): void {
  half(messageId).rest = { committedAt: performance.now(), rest: { ...rest } };
  settle(messageId);
}

export function traceFanout(messageId: string, fanout: FanoutHalf): void {
  half(messageId).fanout = fanout;
  settle(messageId);
}

/** The most recent complete traces (oldest first). */
export function sendTraces(): readonly SendTrace[] {
  return traces;
}
