# Chitthi schema

**Status: approved (2026-10-19).** Target: PostgreSQL 18. It uses the built-in `uuidv7()` and needs no extensions.

**The DDL is in the migrations, and they are authoritative:**
- `db/migrations/20261019110000_app_role.sql`: the `chitthi_app` role.
- `db/migrations/20261019120000_core.sql`: tables, constraints, triggers and grants.

This document explains the model, the rules the database enforces, and the queries the API relies on. If this document and the migration disagree, the migration is right and this document needs fixing.

## 1. Decisions

| # | Decision | Mechanism |
|---|---|---|
| 1 | New group members see history from when they join. | `conversation_memberships.joined_seq` is set to `last_seq + 1` by a trigger under the conversation lock. |
| 2 | Members who leave or are removed keep read-only access to messages up to when they left. | `left_seq` is set to `last_seq` by a trigger when `left_at` is set. The visible window is `[joined_seq, left_seq]`, open-ended while active. One row per membership period, so a rejoin adds a second window. Sending requires an active period, and the DB checks that. |
| 3 | Sending advances the sender's read marker. **Unread = live messages from others after the member's marker**, within their window. | The send transaction raises `read_markers.last_read_seq` to the new seq. Unread is computed by a count query and never stored. |
| 4 | Change cursor. | `conversations.change_seq` is bumped by every new message, edit and delete-for-everyone. `messages.updated_change_seq` holds the row's latest value. Catch-up returns rows with `updated_change_seq > cursor` inside the member's windows. |
| 5 | Limits. | Text is 1–4000 characters and not blank. Handles match `[A-Za-z0-9_]{3,20}` and are **unique case-insensitively**, through a unique index on `lower(handle)`. Display names are 1–60 characters and group titles 1–80. **Reserved handles** (`admin`, `support`, `chitthi`, `system`, …) live in `reserved_handles` and are rejected by a trigger. |
| 6 | No hard deletes. Delete-for-everyone erases content. | The row and its seq stay as a tombstone: the trigger forces `body` and `send_body_sha256` to NULL (and any attachment reference too, once Phase 6 adds one). There is no DELETE grant, and a trigger also refuses deletes. |

## 2. Tables

| Table | Purpose | Key rules |
|---|---|---|
| `reserved_handles` | Handles nobody may take | lowercase only; seeded by the migration |
| `users` | Accounts | `lower(handle)` unique; reserved check; disabled via `disabled_at`, never deleted |
| `identities` | External logins (`google`, `github`, `dev`) | `UNIQUE (provider, subject)`; accounts are never matched by email |
| `sessions` | Server-side sessions | `token_hash bytea`, exactly 32 bytes (SHA-256), unique; no token column; `expires_at`, `revoked_at` |
| `conversations` | DMs and groups | `last_seq` and `change_seq` only increase, written by triggers only; `change_seq ≥ last_seq`; a DM has no title |
| `direct_conversations` | One DM per pair | `UNIQUE (user_lo, user_hi)` with `user_lo < user_hi`; the conversation must be a DM |
| `conversation_memberships` | Membership periods | at most one active period per (conversation, user) (partial unique index); `joined_seq` and `left_seq` set by triggers; a closed period is immutable; DM members are exactly the pair and can't leave; never deleted |
| `read_markers` | One row per (conversation, user): `last_delivered_seq ≥ last_read_seq` | created or advanced by the membership trigger; forward-only; never past the highest seq the user can see |
| `messages` | Text and system messages | `UNIQUE (conversation_id, seq)`, `UNIQUE (conversation_id, updated_change_seq)`, `UNIQUE (sender_id, client_msg_id)`; identity columns immutable; tombstones have no content; never deleted |
| `rate_limits` | rate-limiter-flexible store | `(key, points, expire)` |

**System messages** (`kind = 'system'`, `sender_id` NULL, `meta` jsonb) record membership events: `group_created`, `member_added`, `member_removed`, `member_left`. Each takes a seq like any other message. The add path inserts the membership first and the system message second, so the new member sees "you were added". The remove and leave paths insert the system message first and close the membership second, so the leaving member sees the notice as the last message in their window.

## 3. What the database enforces (not just the API)

1. **Gap-free seq.** `messages_before_insert` (SECURITY DEFINER) does `UPDATE conversations SET last_seq = last_seq + 1, change_seq = change_seq + 1 … RETURNING` inside the inserting transaction. Concurrent sends to one conversation serialise on that row lock. Any failure in the transaction (a duplicate `client_msg_id`, a CHECK, a crash) rolls back the increment with it.
2. **Membership on send.** The same trigger checks for an active membership *after* taking the lock, so a concurrent removal can't let a message land after `left_seq`.
3. **Windows can't be forged.** `joined_seq` and `left_seq` are trigger-assigned under the same lock, and they are immutable afterwards.
4. **The change cursor** is bumped by the insert trigger and by `messages_before_update` on any edit or delete. A no-op update takes no value.
5. **Erasure.** Setting `deleted_at` makes the trigger null the body and body hash. A tombstone can never change again.
6. **Forward-only read markers**, capped at `max(coalesce(left_seq, last_seq))` over the user's periods.
7. **Least privilege.** The API runs as `chitthi_app`, which has column-level grants: it can't write `seq`, `last_seq`, `change_seq`, `joined_seq`, `left_seq` or `updated_change_seq`, and can't DELETE messages, memberships or users. The `DATABASE_ROLE` setting makes every API connection start as `chitthi_app`.

## 4. Queries

The visibility predicate used by every read of messages:

```sql
EXISTS (SELECT 1 FROM conversation_memberships p
         WHERE p.conversation_id = m.conversation_id AND p.user_id = $me
           AND m.seq >= p.joined_seq AND (p.left_seq IS NULL OR m.seq <= p.left_seq))
```

| Operation | Shape |
|---|---|
| Can read? | any membership period for (conversation, user); otherwise 404, so existence isn't leaked |
| Can write? | an active period (`left_at IS NULL`); otherwise 404 if never a member, 403 if read-only |
| Send | Look up `(sender_id, client_msg_id)`. If found: same conversation and same body hash returns the original (`duplicate: true`), anything else returns 409 `idempotency_conflict` (a tombstoned original is returned as is, since its body is erased). Otherwise `INSERT` (the trigger assigns seq and checks membership), then raise the sender's read marker, in one transaction. On `23505 messages_sender_client_key`, the transaction rolls back (so no gap) and the lookup runs again. |
| Edit | `UPDATE messages SET body = $b WHERE id = $id AND sender_id = $me AND kind = 'text' AND deleted_at IS NULL` and the sender is an active member |
| Delete for everyone | `UPDATE messages SET deleted_at = now() WHERE id = $id AND sender_id = $me`; idempotent; allowed for the sender even after leaving (erasing your own words is never blocked) |
| History page | visible messages with `seq < $before`, `ORDER BY seq DESC LIMIT n` (keyset on `messages_conv_seq_key`) |
| Catch-up by seq | visible messages with `seq > $after`, `ORDER BY seq LIMIT n` |
| Catch-up by change cursor | visible messages with `updated_change_seq > $cursor`, `ORDER BY updated_change_seq LIMIT n`. The next cursor is the last row's value if the page is full, otherwise the conversation's `change_seq` from the same snapshot. |
| Mark read / delivered | `GREATEST(marker, LEAST($seq, cap))` where cap is the highest visible seq; never errors, never moves back |
| Unread | `count(*)` of messages with `seq > last_read_seq`, `kind = 'text'`, `deleted_at IS NULL`, `sender_id <> $me`, and `seq <= left_seq` for a former member; capped at 1000 |
| Find or create a DM | Look up the ordered pair. Otherwise insert the conversation, the pair and both memberships in one transaction. On `23505 direct_conversations_pair_key`, roll back and look up again. |

## 5. Rejected alternatives

- **One membership row with a mutable window.** It loses the earlier window on rejoin, which contradicts decision 2.
- **Unread as `last_seq - last_read_seq`.** It counts system messages, tombstones and post-leave messages, and decision 3 excludes all of them. A count over the `(conversation_id, seq)` range is exact and cheap at chat scale.
- **`ON CONFLICT DO NOTHING` on send.** It would commit the seq increment without a message, which is a gap.
- **Hashing the body only at retry time.** After an edit the body differs, so `send_body_sha256` keeps the hash of the *original* send. It is erased with the content on delete.

## 6. Later migrations

- Phase 5: `user_blocks (blocker_id, blocked_id)`, with the check added to the send path.
- Phase 6: `attachments`, plus `messages.attachment_id`, which the delete trigger will also NULL.
- OAuth `state` and the PKCE verifier stay in a short-lived signed cookie, so they need no table.
