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
| `read:updated` / `delivered:updated` | `{conversationId, userId, seq}` | Markers only move forward. |
| `typing` | `{conversationId, userId, typing, ttlMs}` | Ephemeral. Treat `typing: true` as expiring after `ttlMs` unless refreshed. |
| `presence` | `{userId, online, lastSeenAt}` | Only about users who share an active conversation with you. |
| `presence:snapshot` | `{users: [...]}` | Sent once per socket after `ready`. |
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

## 7. Receipts, typing, presence

- **Read and delivered.** These are per-member watermarks (`read_markers`), forward-only and capped by the database. Unread = live text from others after `last_read_seq`, within the window; it is never stored. Sending moves your own read marker to your message.
- **Typing.** Every event is membership-checked against the database. It is relayed only to the other active members, never to the typist's own tabs, at most once per second per tab and conversation. It expires server-side after ~5 s without a refresh, and immediately when the tab closes. It is never persisted.
- **Presence.** Each user has an in-memory set of sockets on this instance.
  - Online when the first socket connects.
  - Offline only after ~10 s with zero sockets, so a reload within the grace produces no events at all.
  - `users.last_seen_at` is written when the user goes offline, and on shutdown.

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

200 sockets (100 members × 2 tabs) in one group, 25 messages, 5000 deliveries. Local run: Postgres 18 in Docker Desktop (WSL2, 256 MB cap), API and clients in one Node process.

| | p50 | p95 | p99 |
|---|---|---|---|
| send start → delivered (REST round trip + fan-out) | ~50–60 ms | ~70–110 ms | ~70–115 ms |
| REST response (commit acknowledged) → delivered | ~15 ms | ~20–30 ms | – |

The test asserts only p95 < 1 s; the numbers vary per run and machine. Most of the end-to-end time is the REST send itself: session lookup, rate limit, membership check and the insert transaction.

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
