// The production-stack smoke workload (deploy/smoke/smoke.sh runs it; it is also the load the
// memory budget is measured under). Production refuses the dev sign-in, so sessions are seeded
// straight into Postgres by the owner, the same way the API stores them: only the SHA-256 hash.
//
//   node deploy/smoke/workload.mjs seed <tokens.json>   prints seed SQL, writes the raw tokens
//   node deploy/smoke/workload.mjs run  <tokens.json>   drives the stack, exits non-zero on failure
//
// Environment: API_BASE and WEB_BASE (both https://chitthi.dhruvgoyal.tech through the edge, or
// the loopback ports without it), ORIGIN (the allowed web origin), IMAGE_MAX_PIXELS (the limit
// the stack runs with: the big image is made exactly that size, and one pixel row more is refused).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { io } from 'socket.io-client';

const USERS = ['smoke_asha', 'smoke_bilal', 'smoke_chen', 'smoke_dana'];
const TABS_PER_USER = 2;
const MESSAGES_PER_USER = 50;
const SEND_INTERVAL_MS = 400;
const FILE_MAX_BYTES = 10 * 1024 * 1024;

const [mode, tokensFile] = process.argv.slice(2);
if (!tokensFile || (mode !== 'seed' && mode !== 'run')) {
  console.error('usage: workload.mjs seed|run <tokens.json>');
  process.exit(2);
}

if (mode === 'seed') {
  const tokens = {};
  const rows = USERS.map((handle) => {
    const token = randomBytes(32).toString('base64url');
    tokens[handle] = token;
    const hash = createHash('sha256').update(token).digest('hex');
    return `WITH u AS (INSERT INTO users (handle, display_name) VALUES ('${handle}', '${handle}') RETURNING id)
INSERT INTO sessions (user_id, token_hash, expires_at) SELECT id, decode('${hash}', 'hex'), now() + interval '1 hour' FROM u;`;
  });
  writeFileSync(tokensFile, JSON.stringify(tokens), { mode: 0o600 });
  console.log(['BEGIN;', ...rows, 'COMMIT;'].join('\n'));
  process.exit(0);
}

const API = process.env.API_BASE ?? 'https://chitthi.dhruvgoyal.tech';
const WEB = process.env.WEB_BASE ?? API;
const ORIGIN = process.env.ORIGIN ?? 'https://chitthi.dhruvgoyal.tech';
const MAX_PIXELS = Number(process.env.IMAGE_MAX_PIXELS ?? 24_000_000);
const tokens = JSON.parse(readFileSync(tokensFile, 'utf8'));

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures += 1;
};
const ms = (t0) => `${Math.round(performance.now() - t0)} ms`;

async function call(handle, method, path, body) {
  const headers = { cookie: `chitthi_session=${tokens[handle]}`, origin: ORIGIN };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, json, bytes: text.length };
}

/** A JPEG of exactly width × height of noise (it barely compresses), as close under 10 MB as the quality allows. */
async function noiseJpeg(width, height) {
  const raw = await sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 24 } } }).raw().toBuffer();
  for (const quality of [92, 85, 75, 60, 45, 30]) {
    const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
    if (jpeg.length <= FILE_MAX_BYTES) return jpeg;
  }
  throw new Error('could not fit the test image under 10 MB');
}

const upload = (handle, name, buf, type) => {
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), name);
  return call(handle, 'POST', '/api/uploads', form);
};

const t0 = performance.now();
const [asha, ...others] = USERS;
const ids = {};
for (const handle of USERS) {
  const me = await call(handle, 'GET', '/api/me');
  check(me.status === 200 && me.json?.user?.handle === handle, `${handle} signed in through a seeded session`);
  ids[handle] = me.json?.user?.id;
}

const anonymous = await new Promise((resolve) => {
  const socket = io(API, { path: '/api/socket.io', transports: ['websocket'], extraHeaders: { origin: ORIGIN }, reconnection: false });
  socket.once('connect', () => { socket.disconnect(); resolve('connected'); });
  socket.once('connect_error', (err) => { socket.disconnect(); resolve(err.message); });
});
check(anonymous === 'unauthenticated', `a socket without a session is refused (${String(anonymous)})`);

const group = await call(asha, 'POST', '/api/conversations', { title: 'Smoke test', memberIds: others.map((h) => ids[h]) });
check(group.status === 201, `group created (${group.status})`);
const conversationId = group.json?.conversation?.id;

// Two tabs per user: every tab must see every message exactly once.
const seen = new Map();
const sockets = [];
await Promise.all(USERS.flatMap((handle) => Array.from({ length: TABS_PER_USER }, (_, tab) => new Promise((resolve, reject) => {
  const socket = io(API, {
    path: '/api/socket.io',
    transports: ['websocket'],
    extraHeaders: { cookie: `chitthi_session=${tokens[handle]}`, origin: ORIGIN },
    reconnection: false,
  });
  const key = `${handle}#${String(tab)}`;
  seen.set(key, new Map());
  socket.on('message:new', (e) => {
    const counts = seen.get(key);
    counts.set(e.seq, (counts.get(e.seq) ?? 0) + 1);
  });
  socket.once('ready', () => { resolve(); });
  socket.once('connect_error', (err) => { reject(new Error(`${key}: ${err.message}`)); });
  sockets.push(socket);
}))));
check(sockets.length === USERS.length * TABS_PER_USER, `${String(sockets.length)} sockets connected through the WebSocket upgrade`);

// Everyone typing at once, each at a pace the production send limit allows (30 per 10 s).
let t = performance.now();
const sends = await Promise.all(USERS.map(async (handle) => {
  const statuses = [];
  for (let i = 0; i < MESSAGES_PER_USER; i += 1) {
    const next = performance.now() + SEND_INTERVAL_MS;
    const r = await call(handle, 'POST', `/api/conversations/${conversationId}/messages`, { clientMsgId: randomUUID(), body: `${handle} ${String(i)}` });
    statuses.push(r.status);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, next - performance.now())));
  }
  return statuses;
}));
const total = USERS.length * MESSAGES_PER_USER;
const statusCounts = Object.entries(Object.groupBy(sends.flat(), String)).map(([s, l]) => `${s}×${String(l.length)}`).join(' ');
check(sends.flat().every((s) => s === 201), `${String(total)} messages sent by ${String(USERS.length)} users in ${ms(t)} (${statusCounts})`);

// The big one: an image of exactly the pixel limit, as close to the 10 MB cap as it gets,
// through decode, EXIF strip, re-encode and thumbnail.
t = performance.now();
const side = Math.floor(Math.sqrt(MAX_PIXELS / 1.5));
const width = Math.floor(side * 1.5);
const height = Math.floor(MAX_PIXELS / width);
const big = await noiseJpeg(width, height);
const made = ms(t);
t = performance.now();
const up = await upload(asha, 'max-size.jpg', big, 'image/jpeg');
check(up.status === 201 && up.json?.attachment?.kind === 'image',
  `max-size image ${String(width)}×${String(height)} (${(width * height / 1e6).toFixed(1)} MP, ${(big.length / 1048576).toFixed(1)} MB, made in ${made}) processed in ${ms(t)} (${String(up.status)})`);
const attachmentId = up.json?.attachment?.id;
const withPhoto = await call(asha, 'POST', `/api/conversations/${conversationId}/messages`, { clientMsgId: randomUUID(), body: 'photo', attachmentIds: [attachmentId] });
check(withPhoto.status === 201, 'message with the photo sent');

const full = await call(others[0], 'GET', `/api/attachments/${attachmentId}`);
check(full.status === 200 && /^attachment/.test(full.headers.get('content-disposition') ?? '') && full.headers.get('x-content-type-options') === 'nosniff',
  `a member downloads it as an attachment with nosniff (${String(full.status)})`);
const thumb = await call(others[1], 'GET', `/api/attachments/${attachmentId}/thumb`);
check(thumb.status === 200, `a member gets its thumbnail (${String(thumb.status)})`);

// Two more at the limit, from two people at once: with IMAGE_CONCURRENCY=1 the second waits for
// the first, so the memory spike is one decode, not two.
t = performance.now();
const pair = await Promise.all([upload(others[0], 'max-a.jpg', big, 'image/jpeg'), upload(others[1], 'max-b.jpg', big, 'image/jpeg')]);
check(pair.every((r) => r.status === 201), `two max-size images uploaded at once both processed in ${ms(t)} (${pair.map((r) => String(r.status)).join(', ')})`);

// One pixel row over the limit: refused before decoding, nothing kept, the API keeps serving.
const over = await sharp({ create: { width, height: height + 1, channels: 3, background: '#808080' } }).jpeg().toBuffer();
const refused = await upload(asha, 'over.jpg', over, 'image/jpeg');
check(refused.status === 413 && refused.json?.error?.code === 'too_large', `an image over the pixel limit is refused with 413 (${String(refused.status)})`);

const history = await call(others[2], 'GET', `/api/conversations/${conversationId}/messages?limit=100`);
check(history.status === 200 && Array.isArray(history.json?.messages), `history page read (${String(history.json?.messages?.length)} messages)`);

// Fan-out settles within a moment of the last send.
const expected = total + 2; // plus the group_created system message and the photo message
const deadline = Date.now() + 5000;
const complete = () => [...seen.values()].every((m) => m.size >= expected - 1);
while (!complete() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
const dupes = [...seen.values()].some((m) => [...m.values()].some((n) => n > 1));
const counts = [...seen.values()].map((m) => m.size);
// group_created is emitted before any tab connects; every later message must reach every tab.
check(counts.every((n) => n === expected - 1) && !dupes, `every tab got all ${String(expected - 1)} live messages once (${counts.join(', ')})`);

for (const s of sockets) s.disconnect();

const page = await fetch(`${WEB}/c/deep/link`);
check(page.status === 200 && (page.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"), 'a deep link gets the app shell with its CSP');

const health = await fetch(`${API}/api/health`);
check(health.status === 200, `health after the workload (${String(health.status)}) in ${ms(t0)} total`);

console.log(failures === 0 ? 'workload passed' : `workload FAILED: ${String(failures)} check(s)`);
process.exit(failures === 0 ? 0 : 1);
