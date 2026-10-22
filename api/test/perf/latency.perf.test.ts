import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { MessageEvent } from '../../src/realtime/fanout.js';
import { sendTraces } from '../../src/timing.js';
import { as, signIn, type Signed } from '../apphelpers.js';
import { appPool } from '../dbhelpers.js';
import { connect, sleep, startTestServer, waitUntil, type TestServer } from '../sockets.js';

// Timing-sensitive (npm run test:perf; its own CI job): 200 sockets in the test process, so a
// busy machine shows up directly in the numbers. Prints LATENCY, STAGES and WORST lines
// (docs/REALTIME.md, "Measured latency"); asserts only p95 < 1 s.
const apiUrl = inject('apiDbUrl');

describe.skipIf(!apiUrl)('real-time latency under load', () => {
  const pool = appPool(apiUrl, 20);
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(pool, apiUrl, { listenerBackoff: { minMs: 50, maxMs: 200 } });
  });
  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  const api = (u: Signed) => as(server.url, u);
  const send = async (u: Signed, conversationId: string, body: string) => {
    const res = await api(u).post(`/conversations/${conversationId}/messages`, { clientMsgId: randomUUID(), body });
    if (res.status !== 201) throw new Error(`send failed: ${String(res.status)}`);
    return res.body.message as { id: string; seq: number };
  };

  it('200 sockets: commit-to-delivery latency', async () => {
    const members = await Promise.all(Array.from({ length: 100 }, () => signIn(server.url, 'lat')));
    const sender = await signIn(server.url, 'lat');
    const gid = (await api(sender).post('/conversations', { title: 'Latency', memberIds: members.map((m) => m.id) })).body.conversation.id as string;
    // Connect in waves of 20 users. All 200 at once is an O(N²) presence burst (each user coming
    // online is announced to its 100 group-mates and gets a snapshot of them): about 3 s on a
    // laptop, and with parallel test files the last sockets could exceed the 5 s ready timeout.
    // The burst is setup here, not what this test measures.
    const sockets: Awaited<ReturnType<typeof connect>>[] = [];
    for (let i = 0; i < members.length; i += 20) {
      const wave = members.slice(i, i + 20);
      sockets.push(...(await Promise.all(wave.map(async (m) => [await connect(server, m), await connect(server, m)]))).flat());
    }
    expect(sockets).toHaveLength(200);
    // Measure steady state: let the setup burst (200 connects, snapshots, the group's presence
    // introduction) finish first. The clients share this process with the server.
    await server.realtime.idle();
    await sleep(1_000);

    const N = 25;
    const sentAt = new Map<number, number>();
    const ackAt = new Map<number, number>();
    const latencies: number[] = [];
    const commitLatencies: number[] = [];
    let delivered = 0;
    const firstAt = new Map<number, number>();
    const lastAt = new Map<number, number>();
    const idOf = new Map<number, string>();
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const gcs: { start: number; ms: number }[] = [];
    const gcObserver = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcs.push({ start: e.startTime, ms: e.duration }); });
    gcObserver.observe({ entryTypes: ['gc'] });
    for (const s of sockets) {
      s.on('message:new', (e: MessageEvent) => {
        if (e.conversationId !== gid) return;
        const now = performance.now();
        if (!firstAt.has(e.seq)) firstAt.set(e.seq, now);
        lastAt.set(e.seq, now);
        const t0 = sentAt.get(e.seq);
        const t1 = ackAt.get(e.seq);
        if (t0 !== undefined) latencies.push(now - t0);
        if (t1 !== undefined) commitLatencies.push(now - t1);
        delivered++;
      });
    }
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const seq = i + 2; // seq 1 is group_created
      sentAt.set(seq, t0);
      idOf.set(seq, (await send(sender, gid, `ping ${String(i)}`)).id);
      ackAt.set(seq, performance.now());
      await sleep(40);
    }
    await waitUntil(() => delivered === N * 200, 20_000, 'every socket to receive every message');

    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((x, y) => x - y);
      return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN) * 10) / 10;
    };
    const report = {
      sockets: 200, messages: N, deliveries: delivered,
      sendToDeliveryMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99) },
      // Measured from the REST response (commit acknowledged); negative = pushed before the response arrived.
      ackToDeliveryMs: { p50: pct(commitLatencies, 50), p95: pct(commitLatencies, 95) },
    };
    process.stderr.write(`\nLATENCY ${JSON.stringify(report)}\n`);
    loop.disable();
    gcObserver.disconnect();

    // Where the time goes (docs/REALTIME.md, "Measured latency"): every stage of each send, then
    // emit -> first and -> last of the 200 sockets (these clients share the server's event loop).
    const traces = new Map(sendTraces().map((t) => [t.messageId, t]));
    const series: Record<string, number[]> = {};
    const add = (k: string, v: number) => { (series[k] ??= []).push(v); };
    for (const [seq, id] of idOf) {
      const t = traces.get(id);
      if (!t) continue;
      add('request', t.restStartedAt - (sentAt.get(seq) ?? NaN));
      for (const [stage, ms] of Object.entries(t.rest)) add(`rest.${stage}`, ms);
      add('notify', t.notifyMs);
      add('queue', t.queueMs);
      add('read', t.readMs);
      add('emit', t.emitMs);
      add('emitToFirstSocket', (firstAt.get(seq) ?? NaN) - t.emittedAt);
      add('emitToLastSocket', (lastAt.get(seq) ?? NaN) - t.emittedAt);
    }
    expect(series.notify?.length).toBe(N); // every send traced end to end
    const stages = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, { p50: pct(v, 50), p95: pct(v, 95), max: pct(v, 100) }]));
    const ms = (ns: number) => Math.round(ns / 1e4) / 100;
    const eventLoop = { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) };
    process.stderr.write(`STAGES ${JSON.stringify({ stages, eventLoopDelayMs: eventLoop })}\n`);
    // p99 over 5000 deliveries is set by the slowest single message (200 deliveries each), so
    // print that message's own breakdown: which stage a one-off stall landed in.
    const round = (x: number) => Math.round(x * 10) / 10;
    const worst = [...idOf].map(([seq, id], index) => ({ index, seq, totalMs: (lastAt.get(seq) ?? NaN) - (sentAt.get(seq) ?? NaN), t: traces.get(id) }))
      .sort((x, y) => y.totalMs - x.totalMs)[0];
    if (worst?.t) {
      const { t } = worst;
      process.stderr.write(`WORST ${JSON.stringify({
        index: worst.index, totalMs: round(worst.totalMs),
        request: round(t.restStartedAt - (sentAt.get(worst.seq) ?? NaN)),
        rest: Object.fromEntries(Object.entries(t.rest).map(([k, v]) => [k, round(v)])),
        notify: round(t.notifyMs), queue: round(t.queueMs), read: round(t.readMs), emit: round(t.emitMs),
        emitToLastSocket: round((lastAt.get(worst.seq) ?? NaN) - t.emittedAt),
        gcPausesInWindowMs: gcs.filter((g) => g.start + g.ms >= (sentAt.get(worst.seq) ?? 0) && g.start <= (lastAt.get(worst.seq) ?? 0)).map((g) => round(g.ms)),
        gcMaxMs: round(Math.max(0, ...gcs.map((g) => g.ms))),
      })}\n`);
    }
    expect(report.sendToDeliveryMs.p95).toBeLessThan(1_000);
    for (const s of sockets) s.disconnect();
  }, 120_000);
});
