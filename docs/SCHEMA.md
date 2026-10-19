# Chitthi schema proposal (Phase 2)

**Status: proposed, awaiting approval.** No domain migration is written until this is approved. Target: PostgreSQL 18. It uses the built-in `uuidv7()` and needs no extensions.

**What has been validated:** the DDL in §3 and §7 was run on PGlite (PostgreSQL 18.3 compiled to WASM), because Docker was not running at the time. The script checked:
- seq goes 1..n
- a duplicate `client_msg_id` rolls back without leaving a gap
- a non-member's insert is a no-op
- hard deletes, seq changes, edits to tombstones, empty or oversized bodies, backward or out-of-range read markers, a decreasing `last_seq`, duplicate DM pairs, bad handles and short token hashes are all rejected
- the §4 history query uses `messages_conv_seq_key` (an index-only scan)

**Not yet validated:** concurrency. PGlite has a single connection. The "100 concurrent sends give seq 1..100" proof is a Phase 3 integration test against the real Postgres 18 container.

This document covers users, identities (OAuth), sessions, conversations, members (including the read markers), messages and rate limits. It also sketches the later tables for Phase 6 (blocks) and Phase 7 (attachments).

## 1. Design in one paragraph

A conversation is the only addressable chat object, identified by a `uuid` (socket room `conv:<id>`). Membership is a row in `conversation_members`, and every read or write checks it by primary key. Messages are ordered by a per-conversation `seq`. A `BEFORE INSERT` trigger assigns it by incrementing `conversations.last_seq` **inside the inserting transaction**, so a rolled-back insert also rolls back the increment, and the sequence stays gap-free with no application discipline needed. Read state is two watermarks per member (`last_delivered_seq`, `last_read_seq`) that triggers only allow to move forward. Unread count is always `conversations.last_seq − members.last_read_seq`. It is computed and never stored, so it can't drift. Sessions store `sha256(token)` only.

## 2. Conventions

- Primary keys are `uuid DEFAULT uuidv7()`. They are time-ordered, so B-tree inserts stay compact, and they are safe to expose.
- All times are `timestamptz`. The server writes them with `now()`. Ordering never uses timestamps.
- Counters are `bigint`. `api/src/db.ts` parses int8 to a JS number and throws beyond 2^53.
- Every enum-like column is `text` with a `CHECK`, so migrations stay simple.
- **Nothing in this schema is hard-deleted by the app.** Messages are soft-deleted (tombstones keep their `seq`), and users are disabled. Foreign keys default to `RESTRICT`. The exceptions are sessions and identities, which cascade from users.
- Constraint names are explicit, so the API can map `23505`/`23514` violations to precise error codes.

## 3. DDL

This is what the first domain migration would contain, as `db/migrations/2026xxxxxxxxxx_core.sql` with a `-- migrate:down` that drops everything in reverse order.

```sql
-- ─────────────────────────────────────────────────────────────── users
CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  handle        text        NOT NULL,
  display_name  text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  CONSTRAINT users_handle_format    CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
  CONSTRAINT users_display_name_len CHECK (char_length(display_name) BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX users_handle_key ON users (handle);

-- ────────────────────────────────────────────────────────── identities
-- One row per external login. `subject` is the provider's stable id (Google `sub`, GitHub
-- numeric id). Never match accounts on email. 'dev' rows are created only by the dev sign-in
-- (development/test); the app refuses to create them in production.
CREATE TABLE identities (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider        text        NOT NULL,
  subject         text        NOT NULL,
  email           text,
  email_verified  boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identities_provider_check CHECK (provider IN ('google', 'github', 'dev')),
  CONSTRAINT identities_subject_len    CHECK (char_length(subject) BETWEEN 1 AND 255),
  CONSTRAINT identities_provider_subject_key UNIQUE (provider, subject)
);
CREATE INDEX identities_user_idx ON identities (user_id);

-- ──────────────────────────────────────────────────────────── sessions
-- The cookie carries a 256-bit random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    bytea       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent    text,
  CONSTRAINT sessions_token_hash_len  CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expiry_order    CHECK (expires_at > created_at),
  CONSTRAINT sessions_user_agent_len  CHECK (char_length(user_agent) <= 200),
  CONSTRAINT sessions_token_hash_key  UNIQUE (token_hash)
);
-- "Sign out everywhere" and the socket kill switch look up live sessions per user.
CREATE INDEX sessions_user_live_idx ON sessions (user_id) WHERE revoked_at IS NULL;
-- Cleanup job: DELETE FROM sessions WHERE expires_at < now() - interval '30 days'.
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ─────────────────────────────────────────────────────── conversations
CREATE TABLE conversations (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  kind             text        NOT NULL,
  title            text,
  created_by       uuid        NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Highest seq assigned in this conversation. Written only by messages_assign_seq().
  last_seq         bigint      NOT NULL DEFAULT 0,
  last_message_at  timestamptz,
  CONSTRAINT conversations_kind_check     CHECK (kind IN ('direct', 'group')),
  CONSTRAINT conversations_title_by_kind  CHECK (
    (kind = 'group'  AND title IS NOT NULL AND char_length(title) BETWEEN 1 AND 80) OR
    (kind = 'direct' AND title IS NULL)),
  CONSTRAINT conversations_last_seq_nonneg CHECK (last_seq >= 0)
);

-- Exactly one direct conversation per unordered pair of users (no self-DMs).
CREATE TABLE direct_conversations (
  conversation_id  uuid PRIMARY KEY REFERENCES conversations (id),
  user_lo          uuid NOT NULL REFERENCES users (id),
  user_hi          uuid NOT NULL REFERENCES users (id),
  CONSTRAINT direct_conversations_ordered CHECK (user_lo < user_hi),
  CONSTRAINT direct_conversations_pair_key UNIQUE (user_lo, user_hi)
);

-- ──────────────────────────────────────── members (and the read markers)
-- Read markers live on the member row: one row per (conversation, user), both watermarks
-- monotonic, so the same unread count shows on every tab and device.
CREATE TABLE conversation_members (
  conversation_id     uuid        NOT NULL REFERENCES conversations (id),
  user_id             uuid        NOT NULL REFERENCES users (id),
  role                text        NOT NULL DEFAULT 'member',
  joined_at           timestamptz NOT NULL DEFAULT now(),
  -- Messages with seq > visible_from_seq are visible to this member: last_seq at (re)join.
  visible_from_seq    bigint      NOT NULL DEFAULT 0,
  left_at             timestamptz,
  last_delivered_seq  bigint      NOT NULL DEFAULT 0,
  last_read_seq       bigint      NOT NULL DEFAULT 0,
  muted_until         timestamptz,
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT members_role_check       CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT members_read_after_join  CHECK (last_read_seq >= visible_from_seq),
  CONSTRAINT members_delivered_ge_read CHECK (last_delivered_seq >= last_read_seq)
);
-- Inbox: the active conversations of one user.
CREATE INDEX members_user_active_idx ON conversation_members (user_id) WHERE left_at IS NULL;

-- ────────────────────────────────────────────────────────────── messages
CREATE TABLE messages (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  conversation_id  uuid        NOT NULL REFERENCES conversations (id),
  -- Assigned by messages_assign_seq(); any value supplied by the caller is overwritten.
  seq              bigint      NOT NULL DEFAULT 0,
  sender_id        uuid        REFERENCES users (id),
  -- Client-generated (UUIDv7 from the browser) for idempotent sends; NULL for system messages.
  client_msg_id    uuid,
  kind             text        NOT NULL,
  body             text,
  -- System messages only: {"event": "member_added", "actor": "<uuid>", "target": "<uuid>"}.
  meta             jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  edited_at        timestamptz,
  deleted_at       timestamptz,
  CONSTRAINT messages_kind_check       CHECK (kind IN ('text', 'system')),
  CONSTRAINT messages_conv_seq_key     UNIQUE (conversation_id, seq),
  CONSTRAINT messages_sender_client_key UNIQUE (sender_id, client_msg_id),
  CONSTRAINT messages_text_shape CHECK (kind <> 'text' OR (sender_id IS NOT NULL AND client_msg_id IS NOT NULL AND meta IS NULL)),
  CONSTRAINT messages_system_shape CHECK (kind <> 'system' OR (client_msg_id IS NULL AND meta IS NOT NULL)),
  -- Live text has 1–4000 characters; a tombstone has no body at all.
  CONSTRAINT messages_body_check CHECK (
    (deleted_at IS NULL AND (kind <> 'text' OR char_length(body) BETWEEN 1 AND 4000)) OR
    (deleted_at IS NOT NULL AND body IS NULL))
);
-- messages_conv_seq_key's index serves history pages (seq < cursor) and catch-up (seq > after).

-- ──────────────────────────────────────────────────────── rate limits
-- Store for rate-limiter-flexible's RateLimiterPostgres (tableCreated: true), so limits hold
-- across restarts and API instances. Replaces the Phase 1 in-memory limiter.
CREATE TABLE rate_limits (
  key     varchar(255) PRIMARY KEY,
  points  integer      NOT NULL DEFAULT 0,
  expire  bigint
);

-- ─────────────────────────────────────────────── integrity triggers
-- 1. Gap-free seq, assigned in the inserting transaction. The UPDATE takes the conversation's
--    row lock, so concurrent sends to one conversation serialise here (and only here); a
--    failed insert (e.g. duplicate client_msg_id) rolls the increment back with it.
CREATE FUNCTION messages_assign_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations
     SET last_seq = last_seq + 1,
         last_message_at = now()
   WHERE id = NEW.conversation_id
  RETURNING last_seq INTO NEW.seq;
  IF NEW.seq IS NULL THEN
    RAISE EXCEPTION 'conversation % does not exist', NEW.conversation_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_assign_seq BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_assign_seq();

-- 2. Identity columns of a message never change, and messages are never hard-deleted
--    (a delete would open a gap). Edits and tombstones are UPDATEs of body/edited_at/deleted_at.
CREATE FUNCTION messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'messages are never hard-deleted; set deleted_at' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.conversation_id <> OLD.conversation_id OR NEW.seq <> OLD.seq
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.client_msg_id IS DISTINCT FROM OLD.client_msg_id
     OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable message column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted message cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_guard BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_guard();

-- 3. last_seq only grows (it's only ever written by trigger 1, but enforce it).
CREATE FUNCTION conversations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_seq < OLD.last_seq THEN
    RAISE EXCEPTION 'conversations.last_seq cannot decrease' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'conversations.kind is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_guard BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_guard();

-- 4. Read markers only move forward and never past the conversation's last_seq. A rejoin
--    (left_at going from non-NULL to NULL) is the one time visible_from_seq may move, and the
--    markers jump forward with it.
CREATE FUNCTION members_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conv_last bigint;
BEGIN
  SELECT last_seq INTO conv_last FROM conversations WHERE id = NEW.conversation_id;
  IF NEW.last_read_seq > conv_last OR NEW.last_delivered_seq > conv_last THEN
    RAISE EXCEPTION 'read marker beyond last_seq' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.last_read_seq < OLD.last_read_seq OR NEW.last_delivered_seq < OLD.last_delivered_seq THEN
      RAISE EXCEPTION 'read markers only move forward' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.visible_from_seq <> OLD.visible_from_seq AND NOT (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL) THEN
      RAISE EXCEPTION 'visible_from_seq changes only on rejoin' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER members_guard BEFORE INSERT OR UPDATE ON conversation_members
  FOR EACH ROW EXECUTE FUNCTION members_guard();
```

## 4. The queries this schema exists for

**Membership check**, which runs on every REST call and socket event that touches a conversation. It is a primary-key lookup:

```sql
SELECT role, visible_from_seq FROM conversation_members
 WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL;   -- no row → 404
```

**Send (idempotent)**, all in one transaction:

```sql
-- a) Retry fast path: same sender, same client id → return the stored row (409 if it was a
--    different conversation).
SELECT * FROM messages WHERE sender_id = $me AND client_msg_id = $cid;
-- b) Insert. The membership check is inside the statement, and the trigger assigns seq.
INSERT INTO messages (conversation_id, sender_id, client_msg_id, kind, body)
SELECT $conv, $me, $cid, 'text', $body
 WHERE EXISTS (SELECT 1 FROM conversation_members
                WHERE conversation_id = $conv AND user_id = $me AND left_at IS NULL)
RETURNING id, seq, created_at;                                -- 0 rows → 404
-- c) The sender has read everything up to their own message.
UPDATE conversation_members
   SET last_delivered_seq = GREATEST(last_delivered_seq, $seq),
       last_read_seq      = GREATEST(last_read_seq, $seq)
 WHERE conversation_id = $conv AND user_id = $me;
```

If two retries race past (a), the second insert hits `messages_sender_client_key` (`23505`). Its transaction rolls back, **including the seq increment**, and the API answers with the row from (a) on a fresh read. **Never `ON CONFLICT DO NOTHING` here:** that would commit the increment without a message and open a gap. This corrects the wording in AUDIT.md §P2.

**History page and gap catch-up** (keyset; uses `messages_conv_seq_key`):

```sql
SELECT … FROM messages WHERE conversation_id = $1 AND seq > $visible_from AND seq < $before ORDER BY seq DESC LIMIT 50;
SELECT … FROM messages WHERE conversation_id = $1 AND seq > GREATEST($after, $visible_from) ORDER BY seq LIMIT 500;
```

**Mark read**:

```sql
UPDATE conversation_members m
   SET last_read_seq = GREATEST(m.last_read_seq, LEAST($seq, c.last_seq)),
       last_delivered_seq = GREATEST(m.last_delivered_seq, LEAST($seq, c.last_seq))
  FROM conversations c
 WHERE c.id = m.conversation_id AND m.conversation_id = $1 AND m.user_id = $me AND m.left_at IS NULL
RETURNING m.last_read_seq;
```

**Inbox with unread counts.** The unread count is derived, never stored:

```sql
SELECT c.id, c.kind, c.title, c.last_seq, c.last_message_at,
       m.last_read_seq, c.last_seq - m.last_read_seq AS unread
  FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
 WHERE m.user_id = $me AND m.left_at IS NULL
 ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
 LIMIT 50;
```

**"Seen by" for a group message**: `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL AND last_read_seq >= $seq`.

**Find or create a DM**: look up `direct_conversations (user_lo, user_hi)`. If there is none, one transaction inserts the conversation, the pair and both members, and `direct_conversations_pair_key` resolves a race to a single winner.

## 5. How this maps to the invariants (CLAUDE.md)

| Invariant | Enforced by |
|---|---|
| Gap-free per-conversation seq, assigned in the DB transaction | `messages_assign_seq` trigger + `messages_conv_seq_key`; `messages_guard` forbids deletes and seq changes |
| Idempotent sends | `messages_sender_client_key` + retry fast path; no `ON CONFLICT DO NOTHING` |
| Membership re-checked every operation | PK lookup on `conversation_members`; send's insert carries the check in-statement |
| Room ids never from usernames | rooms are `conv:<conversations.id>`, `user:<users.id>`; handles can change freely |
| Sessions hashed at rest | `sessions.token_hash bytea` (32 bytes), unique; no token column exists |
| Unread derived, never incremented | no counter column; `last_seq − last_read_seq`; `members_guard` keeps markers monotonic and ≤ `last_seq` |

## 6. Decisions I need from you

1. **New group members see history from when they join** (`visible_from_seq = last_seq` at join). The alternative is full history. I propose from-join; it matches what people expect from groups and leaks less.
2. **Former members lose read access entirely.** The alternative is keeping access up to the point they left, which needs a `left_seq` column. I propose losing access: it's simpler and stricter. A rejoin gives fresh visibility from the rejoin point.
3. **Sending moves your own read marker to your message.** This also marks earlier unread messages as read, the way Slack and WhatsApp behave. The alternative is exact per-message unread excluding your own messages, which needs a count query instead of a subtraction.
4. **Edits and deletes.** The columns and guards are in, but there is no API for them until after Phase 5. If you want edits to sync after a reconnect, add a per-conversation change cursor (`conversations.last_rev`, `messages.rev`), bumped by the same trigger pattern. I can include that now or defer it.
5. **Limits:** text messages up to 4000 characters; handles `[a-z0-9_]{3,20}`; display names 1–60; group titles 1–80.
6. **No hard deletes** of messages or conversations. Account deletion, and any retention policy, would be a separate, explicit design.

## 7. Later migrations (sketch, not in the first domain migration)

```sql
-- Phase 6: blocks (a block hides DMs both ways and rejects sends; enforced in the send query).
CREATE TABLE user_blocks (
  blocker_id uuid NOT NULL REFERENCES users (id),
  blocked_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);

-- Phase 7: attachments; messages gain kind 'attachment' and attachment_id.
CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id     uuid NOT NULL REFERENCES users (id),
  storage_key  text NOT NULL UNIQUE,          -- random; never the original filename
  mime         text NOT NULL,                 -- from magic bytes, not the client
  size_bytes   bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256       bytea NOT NULL CHECK (octet_length(sha256) = 32),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

The OAuth `state`/PKCE verifier stays in a short-lived signed, HttpOnly cookie (as Splitwise does), so it needs no table.

## 8. What replaces the Phase 1 in-memory pieces

- `MemorySessionStore` is replaced by a `PgSessionStore` on `sessions`, with the same `SessionStore` interface and tests.
- `devUserId()` (hash-derived ids) is replaced by `users` + an `identities` row with `provider = 'dev'`, `subject = handle`.
- `RateLimiterMemory` is replaced by `RateLimiterPostgres` on `rate_limits`.
