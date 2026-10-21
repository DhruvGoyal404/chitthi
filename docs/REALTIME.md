# Real-time delivery

How Chitthi gets a committed message onto every screen that should show it, and nowhere else. The code lives in `api/src/realtime/`, `api/src/routes.ts` and `web/src/sync/`. The tests are in `api/test/realtime.*.db.test.ts` and `web/src/sync/sync.test.ts`.

## 1. Shape of the system

```
 browser tab ──REST──▶ POST /api/conversations/:id/messages ──▶ Postgres (one transaction)
     ▲                    response = stored row + seq (ack)       │  INSERT messages
     │                                                            │  trigger: seq, change_seq
     │                                                            │  trigger: pg_notify(ids only)
     │                                                            ▼  (delivered on COMMIT)
     │   Socket.IO /api/socket.io        ┌──────────── one LISTEN connection (PgListener)
     └──── user:<id> room ◀── emit ──────┤  single ordered queue
                                         │  per notification: one SELECT of the row
                                         │  + every user whose window contains its seq
                                         └──────────────────────────────────────────────
```

- **All writes are REST.** Sends, edits, deletes and read markers go over REST. The only inbound socket events are `typing` and `delivered`, and any other event disconnects the socket.
- **Every push comes from the database.** No route handler emits to a socket. The only path to a client is commit → `NOTIFY` → listener → fan-out, so ordering and visibility are decided in one place.

## 2. Why REST to send, socket to push

**Sending over REST:**
- The HTTP response is a natural, reliable ack. It carries the stored row with its `seq`, or a precise error such as 409 `idempotency_conflict`, 403 `read_only` or 429.
- Retries are plain HTTP retries with the same `clientMsgId`, and idempotency is enforced by `UNIQUE (sender_id, client_msg_id)`.
- Authorization, validation, rate limiting and the Origin check are the same middleware as every other write.
- There is one code path to test.

**Rejected: sending over the socket.**
- Socket.IO acks are per-connection. A reconnect in the middle of a send leaves the client unsure whether the send landed, which is the retry problem again without HTTP's semantics.
- It would duplicate auth, validation and rate limiting in a second transport.

**Pushing the message itself, not just a "something changed" signal:**
- Pushing the row saves a REST round trip per message per recipient, which matters for latency and for N recipients.
- `seq` and `changeSeq` make pushes safe to lose: a gap is detectable, and REST catch-up repairs it.
- **Rejected: notify-then-pull** (push "conversation X changed at seq N", client fetches). It is simpler, but every message costs every recipient an HTTP request. Since the REST catch-up path has to exist for reconnects anyway, pushing the row costs little extra.

## 3. NOTIFY carries ids, never bodies

PostgreSQL's `NOTIFY` payload is limited to **8000 bytes**. A message body can be 4000 code points, which is up to 16 KB of UTF-8 (the 4000-emoji test sends exactly 16,000 bytes). So triggers notify only small JSON:

| Channel | Payload | Trigger |
|---|---|---|
| `chitthi_conv` | `{kind: "message_new" \| "message_updated", conversation_id, message_id, seq, change_seq}` | `messages_notify` (AFTER INSERT/UPDATE; no-op updates send nothing) |
| `chitthi_conv` | `{kind: "markers", conversation_id, user_id, read_seq, delivered_seq, read_moved, delivered_moved}` | `read_markers_notify` |
| `chitthi_conv` | `{kind: "member_joined", conversation_id, user_id}` | `memberships_notify` (presence introductions) |
| `chitthi_session` | `{session_id}` or `{user_id}` | session revoked; user disabled |

The listener reads the row once, as it is at that moment. If the message was deleted for everyone before fan-out reached it, the push carries the tombstone (`body: null`); the erased text is never sent. NOTIFY is transactional: a rolled-back send notifies nobody, and notifications arrive in commit order.

## 4. Fan-out, rooms and visibility

- **Rooms.** Each socket joins exactly `user:<userId>`, plus `session:<sessionId>`, which is used only to cut it off. Clients never choose rooms, so there is no room for a client to "join", and that whole class of attack (audit S2/S3) doesn't exist.
- **Recipients.** For a message with seq `s`, the recipients are every user with a membership period where `joined_seq ≤ s` and (`left_seq` is NULL or `s ≤ left_seq`). Windows are assigned by triggers under the conversation lock and never change, so the answer is the same whenever the notification is processed:
  - a removed member gets their own removal notice (seq = `left_seq`) and nothing after it;
  - a new member gets their "added" notice (seq = `joined_seq`) and nothing before it.
- **Receipts** (`read:updated`, `delivered:updated`) go to the reader's own tabs and to the other active members. Former members get none.
- **One ordered queue.** Every notification is processed in order, so pushes leave the server in commit order.

## 5. Events

Server → client:

| Event | Payload | Notes |
|---|---|---|
| `ready` | `{userId}` | Rooms are joined. |
| `message:new` | `{conversationId, seq, changeSeq, message}` | `changeSeq` is the change value this event consumed. `message` is the stored row, which may be a newer version. |
| `message:updated` | same | An edit, or a delete-for-everyone (`message.body: null`, `deletedAt` set). |
| `read:updated` / `delivered:updated` | `{conversationId, userId, seq}` | Markers only move forward. `read:updated` also means delivered up to `seq`; `delivered:updated` is sent only when delivery moves on its own. |
| `typing` | `{conversationId, userId, typing, ttlMs}` | Ephemeral. Treat `typing: true` as expiring after `ttlMs` unless refreshed. |
| `presence` | `{userId, online, lastSeenAt}` | Only about users who share an active conversation with you. |
| `presence:snapshot` | `{users: [...]}` | Sent once per socket after `ready`: the full set the user may see. |
| `presence:update` | `{users: [...]}` | Upsert a few users. Sent when a membership starts (new DM, new group, member added), so the new member and the others learn each other's status without reconnecting. |
| `resync` | none | The server may have missed notifications, so catch up everything (§6). |

Client → server (anything else disconnects):

| Event | Payload | Ack |
|---|---|---|
| `typing` | `{conversationId, typing}` | `{ok: true}` or `{ok: false, code: "not_found" \| "read_only"}` |
| `delivered` | `{conversationId, seq}` | `{ok: true, lastReadSeq, lastDeliveredSeq}` or `{ok: false, code}` |

Malformed payloads disconnect. Inbound events pass a token bucket (burst 20, 5/s); exceeding it disconnects.

## 6. Client sync contract (`web/src/sync/sync.ts`)

Per conversation the client keeps `lastSeq` (every visible message up to it is stored) and `changeCursor` (every change up to it is applied).

1. **`message:new`:** `seq = lastSeq + 1` → apply. `seq ≤ lastSeq` → duplicate (keep the row only if its `changeSeq` is newer). A larger seq → `GET .../messages?after=lastSeq` until `hasMore` is false. Seqs outside the user's windows never arrive, and the frontier moves past them.
2. **Change values:** every row and event records its change value. The cursor advances over contiguous runs. A remaining hole triggers `GET .../changes?after=changeCursor`. This is how a missed edit or delete is repaired. A seq catch-up that already covered the changes needs no extra fetch.
3. **Row versions:** a row is replaced only by a higher `changeSeq`, so a stale or replayed event can't undo an edit or resurrect deleted text.
4. **Ordering:** events for a conversation are handled one at a time; events arriving during a catch-up are applied after it.
5. **(Re)connect or `resync`:** `GET /api/conversations` returns each conversation's `lastSeq` and `changeSeq`. Catch up only the conversations that differ.
6. **Acks:** after storing, send `delivered {conversationId, seq: lastSeq}`, coalesced per conversation (~300 ms). One ack per message would trip the inbound rate limit.
7. **Sends:** generate a UUIDv7 `clientMsgId`, show the bubble as pending, POST it, and on the response replace the pending bubble with the stored row (by `clientMsgId`). Retry with the same id on network failure. The push of your own message is then a duplicate.
8. **First sight of a conversation:** on `resync`/`ready` the list includes each conversation's `lastDeliveredSeq` for me. A conversation the tab hasn't loaded starts at that marker and fetches only the undelivered messages, so delivery is acknowledged without loading whole histories. A push for a conversation the tab doesn't know yet (say, a brand-new DM) starts tracking it from zero and catches up.
9. **Back online (`ready`):** besides the catch-up above, refresh the inbox and the member read markers, and resend every failed, retryable send with its same `clientMsgId`. The browser's `offline` event closes the socket at once (banner: offline) and `online` reconnects.
10. **Multiple tabs and devices:** each tab has its own socket, engine and outbox, and they never coordinate. That is safe because the server is the only source of truth: sends are idempotent by id, read/delivered markers only move forward, and every tab receives every push for the user (rooms are per user). Unsent drafts belong to the tab that wrote them.

The web implementation is `web/src/sync/sync.ts` (rules, unit-tested with a fake socket and server) and `web/src/realtime/client.ts` (socket, outbox, presence, typing, connection state).

## 7. Receipts, typing, presence

- **Read and delivered.** These are per-member watermarks (`read_markers`), forward-only and capped by the database. Unread = live text from others after `last_read_seq`, within the window; it is never stored. Sending moves your own read marker to your message.
- **Typing.** Every event is membership-checked against the database. It is relayed only to the other active members with no block in either direction between them and the typist, never to the typist's own tabs, at most once per second per tab and conversation. It expires server-side after ~5 s without a refresh, and immediately when the tab closes. It is never persisted.
- **Presence.** Each user has an in-memory set of sockets on this instance.
  - Online when the first socket connects.
  - Offline only after ~10 s with zero sockets, so a reload within the grace produces no events at all.
  - `users.last_seen_at` is written when the user goes offline, and on shutdown.
  - It is visible only between users who share an active conversation and have no block in either direction (events, snapshots and introductions alike). A block hides the two from each other at once, reported as offline with no last seen; an unblock restores it if they still share a conversation.
  - When a membership starts, the new member and the other active members get each other's presence (`presence:update`). This happens **outside** the ordered queue and is coalesced per conversation for 25 ms, so a 100-member group creation is one batch (two queries) and never delays message fan-out. A first version did this per membership inside the queue, and the 200-socket test caught it holding message delivery back by ~5 s.

## 8. Guarantees

- **Order:** every client sees a conversation's messages in `seq` order, which is the commit order assigned by the database. Live pushes leave the server in commit order.
- **No loss:** a push is at most once, but together with REST catch-up the client state converges to exactly the committed state. That covers a dropped frame, a reconnect, a listener outage and the client being offline.
- **No duplicates:** sends are idempotent by `(sender, clientMsgId)`. Clients deduplicate pushes by `seq` and by row `changeSeq`.
- **Visibility:** nobody receives a message outside their membership windows. Non-members get nothing, and a removed member gets nothing after their removal notice.
- **Erasure:** after delete-for-everyone, no push, page, catch-up or new tab carries the text.
- **Sessions:** revoking a session, disabling a user or reaching the expiry time disconnects the affected sockets immediately.

## 9. Failure modes

| Failure | What happens | Recovery |
|---|---|---|
| A push is dropped (flaky network, client busy) | The next push shows a seq or change gap | REST catch-up by seq or change cursor |
| A client is offline or asleep | Nothing is queued server-side | On reconnect: conversation list, then catch up the conversations that differ |
| The LISTEN connection dies | Notifications sent meanwhile are lost for good | It reconnects with backoff and jitter, drops sockets whose session ended, and emits `resync` to every socket. Tested by killing the backend. |
| The API process restarts | Sockets drop; presence is reset | Clients reconnect and catch up; presence rebuilds as sockets return |
| Postgres is down | Sends fail (503/500); `/api/health` reports degraded | The listener keeps retrying, and `resync` follows recovery |
| The session is revoked, expired or the user disabled | Sockets are disconnected (via `chitthi_session` NOTIFY or a timer) | The client must sign in again |
| A slow client | The Socket.IO buffer grows for that socket only | The client reconnects and catches up; the server's queue is not blocked by one socket |
| Malformed or abusive inbound events | Disconnect | – |
| A member is removed while sends are in flight | The send trigger re-checks membership under the conversation lock | Accepted sends land at or before `left_seq`; the rest get 403 `read_only` (tested with 30 sends in flight) |

## 10. Measured latency

**The test.** 200 sockets (100 members × 2 tabs) in one group, 25 messages, 5000 deliveries. Clients, API and listener all run in one Node process. Postgres 18 runs in Docker: locally that is Docker Desktop (WSL2, 256 MB cap); in CI, a service container.

**What the test prints.** Each send is timed stage by stage, and the test prints a `STAGES` line next to `LATENCY`:

- **REST stages.** [`api/src/timing.ts`](../api/src/timing.ts) records, per send:
  - session lookup;
  - rate-limit check;
  - validation;
  - idempotency lookup;
  - membership check;
  - pool wait;
  - transaction;
  - commit.

  The same breakdown is returned to the client as a `Server-Timing` header.
- **Fan-out stages.** In the same process: commit → NOTIFY received, the wait in the ordered queue, the row read, the emit, and emit → first and → last socket.
- **Event-loop delay** (`monitorEventLoopDelay`).

### The unexplained p99 (Phase 5)

CI had shown send → delivery p99 ≈ 356 ms, against a p50 of about 8 ms in the same run.

**Measured locally, before the fix** (three runs):

- p99 was 235–250 ms;
- event-loop stalls reached 66–83 ms;
- the `transaction` stage's maximum was 62–76 ms, against a median of 12 ms.

**The database was not the cause:**

- pool wait stayed ≤ 0.2 ms;
- commit → NOTIFY took about 1–5 ms;
- the queue wait was ≤ 0.4 ms.

The slow transactions were waiting for the event loop to run their query callbacks.

**What was blocking the loop.** For every send, the server broadcast to all 200 sockets **three** times: `message:new`, then `read:updated` and `delivered:updated`. The last two exist because sending moves the sender's own read and delivered markers. Each broadcast costs 15–30 ms of synchronous `emit`, plus the same again on the 200 in-process clients that parse it. The next send then queued behind that work.

**Fix 1: the redundant receipt is gone.** `read:updated` already implies delivered up to the same seq (the web client applies both). So when both markers move together to the same seq, as on every send, only `read:updated` is sent. `api/test/realtime.events.db.test.ts` pins this. A delivered-only move, from a client's `delivered` ack, still sends `delivered:updated`.

**Fix 2: the two send limits run concurrently.** The burst and sustained windows used to be checked one after the other; now they are checked at the same time.

**After the fixes** (three runs, same machine):

| | Before | After |
|---|---|---|
| p99 send → delivery | 235–250 ms | 165–192 ms |
| Event-loop stall (max) | 66–83 ms | 39–49 ms |
| `transaction` stage (max) | 62–76 ms | 34–41 ms |

**What remains is expected, and specific to this test.**

- **Shared event loop.** Every message is one synchronous broadcast to 200 sockets, about 15–30 ms. The 200 clients then receive it in the same process, another 15–35 ms. Messages that arrive during that window wait.
- **Production is different.** The server's loop doesn't run the clients, so this stage shrinks to the emit alone.
- **REST path.** At the median it is about 40 ms locally and much less in CI. It is six round trips, each 3–6 ms on Docker Desktop: session, rate limits, idempotency, membership, transaction, commit.
- **Not done: merging the idempotency and membership lookups** into one query. That would save one round trip (about 3–5 ms) and is a possible later optimisation, not a tail fix.

The test asserts only p95 < 1 s. The numbers vary by run and by machine.

## 11. A second API instance

Today Chitthi runs as one instance, which is plenty at this scale. The design is instance-safe for messages already:

- **Message, receipt and session fan-out work across instances as is.** Each instance has its own LISTEN connection, receives every NOTIFY, and pushes to the sockets connected to it (Socket.IO emits to local rooms). Each instance runs the one-row read per notification; that is N× a cheap indexed query.
- **Rate limits** (sign-in, send, socket connect) are already in Postgres and hold across instances.
- **Typing needs cross-instance delivery.** It is relayed socket to socket, so the typist and the recipient may be on different instances. Options:
  - a Socket.IO adapter: `@socket.io/postgres-adapter`, which needs no new service, or the Redis/Valkey adapter on port 6381;
  - or route typing through `pg_notify`, as messages are.
- **Presence needs shared state.** Per-instance socket counts are wrong once a user's tabs span instances. Options:
  - shared counts in Valkey (a hash per user with heartbeats and TTLs), with the grace timer driven by the last instance to see zero;
  - or the adapter's cross-instance `fetchSockets()` for each change.
- **The inbound token bucket is per socket**, so it stays correct with more instances.
- **Load balancing:** with `transports: ['websocket']` no sticky sessions are needed. Long-polling fallback would need them.
- **Resync** is per instance. Each instance resyncs its own sockets after its own listener gap, which is correct.

**What would actually be needed:** the Postgres adapter (for typing) and shared presence counts. Nothing else changes.

## 12. Settings

| Setting | Default | Where |
|---|---|---|
| Typing TTL / relay interval | 5 s / 1 s | `realtime/typing.ts` (`tuning.typing`) |
| Presence grace | 10 s | `realtime/presence.ts` (`tuning.presence`) |
| Inbound token bucket | burst 20, 5/s | `realtime/server.ts` |
| Socket connects per user | 30/min | `limits.ts` |
| Sends/edits/deletes per user | 120/min | `limits.ts` |
| Max inbound frame | 4 KB | `realtime/server.ts` (`maxHttpBufferSize`) |
| Listener backoff | 100 ms → 10 s, jittered | `realtime/listener.ts` |
