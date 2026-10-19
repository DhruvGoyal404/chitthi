# Chitthi

Chitthi (चिट्ठी, "a letter") is a real-time chat app with 1:1 and group conversations, durable history, read receipts, presence and typing indicators. It is a portfolio-scale rewrite of the old Real-Chat-WebApp. `docs/AUDIT.md` covers what was wrong with the old code, and `legacy-ui/` keeps its Tailwind components as a visual reference only.

Never use WhatsApp's name, logo, colours or look anywhere in the product.

## Non-goals

- **End-to-end encryption.** Messages are encrypted in transit (TLS in deployment) and stored in plaintext in Postgres. **The server, and anyone with database access, can read every message.** The UI must never claim otherwise.
- **Voice and video calls.** There is no signalling, WebRTC or call UI. The legacy stubs were removed; don't add new ones.

Stretch goals, only after Phase 7: message search (Postgres full-text) and web push notifications.

## Stack

- `api/`: Node 22, TypeScript (strict), Express 5, zod, pg, pino, and Socket.IO 4 (added in Phase 4).
- `web/`: Vite, React 19, TypeScript (strict), Tailwind v4, TanStack Query, React Router 7.
- `db/migrations/`: dbmate SQL migrations. Run them from the repo root with `npm run db:migrate`, which uses the owner's `MIGRATION_DATABASE_URL` from `.env`. The API itself always logs in as `chitthi_api`, a member of `chitthi_app` with no other privileges, in dev as well as prod. The owner role is for migrations and tests only.
- The repo is a single npm workspace with one `package-lock.json`.

## Invariants

These hold for every change. A change that breaks one of them is a bug, even if its tests pass.

1. **Ordering.** Every message gets a per-conversation, gap-free sequence number (`seq`), assigned inside the same DB transaction that inserts the message (`UPDATE conversations SET last_seq = last_seq + 1 … RETURNING`). The database enforces `UNIQUE (conversation_id, seq)`. The client never orders by timestamps.
2. **Idempotent sends.** Every send carries a client-generated message id. The database enforces `UNIQUE (sender_id, client_msg_id)`, and a retry returns the original row instead of inserting a new one.
3. **Membership is re-checked on the server for every socket event and every REST call** that touches a conversation. Reads are limited to the member's visible windows, `[joined_seq, left_seq]` per membership period. Writes need an active period. Room ids are `conv:<uuid>` and `user:<uuid>`, joined by the server based on the session. They are never derived from usernames and never joined on a client's request.
4. **Message bodies are rendered as text, never as HTML.** No `dangerouslySetInnerHTML`, no markdown-to-HTML, and no URL from a message body goes into `href`, `src` or `window.open` without an allow-listed scheme.
5. **Sessions.** Each session is a random 256-bit token. Only its SHA-256 hash is stored, in memory as well as in the database. There is no JWT. Cookies are `HttpOnly` and `SameSite=Lax`, plus `Secure` in production. Every state-changing HTTP request and the WebSocket upgrade must carry an `Origin` header from the allow-list.
6. **Uploads are never served inline from the app's origin.** Downloads go through a membership-checked route with `Content-Disposition: attachment` (images only under a sandbox CSP), `X-Content-Type-Options: nosniff`, and the type checked by magic bytes. SVG and HTML are refused.
7. **Counters get money-style rigour.**
   - Unread counts are derived from per-member read markers: live messages from others after `last_read_seq`, within the visible window. They are never stored.
   - Read markers only move forward (`GREATEST`, plus a DB trigger).
   - `seq` and `change_seq` are assigned only by DB triggers.
   - Nothing is ever incremented or decremented ad hoc.
   - Delete-for-everyone keeps the row and its seq as a tombstone, with the content erased.
8. **No secrets or connection strings in logs.** The logger scrubs URLs that carry credentials, along with registered secret values. Config errors name the key, never the value. Tests enforce both.
9. **Supply chain.**
   - **14-day release rule:** a dependency version, an action and an image may only be adopted if they were published at least 14 days earlier.
   - Exact pins only (`save-exact=true`; actions pinned by commit SHA; images pinned by digest).
   - CI installs with `npm ci`.
   - Any piped CI step starts with `set -o pipefail`.
   - To add or upgrade a package: `npm install --save-exact --before=<today minus 14 days> <pkg>@<version>`. The `--before` flag also holds back transitive dependencies.

## Coexistence rules (shared machine)

- Work only inside this folder. You may read `../INVENTORY.md`. You may read, but never write or run anything in, `../Splitwise/api/src`, to port its auth, OAuth, session, Origin-check, rate-limit and socket-handshake patterns.
- **Ports used by Chitthi:** web **5175**, API **8082**, Postgres **5435** (host). Valkey 6381 only if it's ever needed.
- **Reserved for others; never bind them:** 5173/8080 (CodeJudge) and 5174/8081/5434 (Hisaab).
- **Compose project `chitthi`.** Volumes are prefixed `chitthi_` (`chitthi_pg`).
- **Docker Desktop is shared.** Never stop, remove, prune or restart containers, images or volumes you didn't create. Never touch anything labelled `judge.managed` or belonging to the `codejudge` or `hisaab` projects. Never change Docker Desktop settings.
- **RAM is limited** (WSL is capped at 6 GB). Postgres is capped at 256 MB. Don't leave services running, and don't start heavy installs without asking.

## Phases

| # | Phase | Done means |
|---|---|---|
| 0 | Audit | `docs/AUDIT.md` reviewed, and the plan approved (Postgres, hashed sessions plus OAuth, rewrite). **Done.** |
| 1 | Foundations | `docker compose up db` gives a healthy Postgres 18 on 5435. `npm run db:migrate` applies the baseline. The API `/api/health` and the web dev server run on 8082 and 5175. Garbage input returns 400 and the process keeps running. A test proves logs contain no secrets. CI is green (typecheck, lint, tests, audit, against a Postgres service). |
| 2 | Data model | `docs/SCHEMA.md` approved. dbmate migrations go up → down → up to an identical schema. Sessions and rate limits live in Postgres. The repository layer covers DMs, groups, membership, idempotent send, edit, delete-for-everyone, read markers, keyset history, and catch-up by seq and by change cursor. DB tests running as `chitthi_app` prove: gap-free seq under 20 concurrent senders; concurrent idempotent retries yield one message; visibility windows on history and catch-up; nothing for non-members; read markers never move back; tombstones have no body; one DM per pair under concurrent creation. |
| 3 | Real-time delivery | Socket tests with two users and three sockets (one user with two tabs) show: the ack arrives before the echo; no duplicates; a gap is repaired after a forced disconnect; presence stays online when one of two tabs closes; read state syncs across tabs; a forged join, or a send to a conversation the user isn't in, is rejected. |
| 4 | Frontend | Two browsers (plus a third tab) can sign in, start a DM, chat, see typing and read state, reload without losing history, and survive going offline and back without duplicates or holes. A Playwright e2e test covers this. |
| 5 | Auth and limits | Google/GitHub OAuth and hashed sessions work, including "log out everywhere". Contact consent and blocks are enforced. helmet/CSP and rate limits (sign-in, send, upload) are in place. `npm audit --omit=dev` shows no high or critical issues. Regression tests exist for the audit's S1–S16 findings. |
| 6 | Media | Authenticated attachments on local disk: size limits, magic-byte checks, a membership-checked download route. Tests reject oversized files, HTML/SVG and renamed executables. Voice notes and images round-trip between two users. |
| 7 | Deploy | Production images (Node 22 LTS, non-root, pinned digests). A presigned object-storage adapter. CI covers lint, typecheck, test and build. On a clean checkout, `docker compose -p chitthi up` serves web, API and DB on the assigned ports. Secrets live only in the platform's secret store. |

## Commands

```
npm ci                      # install (root, all workspaces)
docker compose up -d db     # Postgres 18 on 127.0.0.1:5435 (project "chitthi")
npm run db:migrate          # dbmate up, as the owner (MIGRATION_DATABASE_URL)
npm run db:api-password     # set the chitthi_api login password from DATABASE_URL
npm run dev:api             # API on 127.0.0.1:8082
npm run dev:web             # web on http://localhost:5175 (proxies /api, including WebSockets, to 8082)
npm run typecheck && npm run lint && npm test
```

Dev sign-in shortcut: set `DEV_LOGIN=true` with `NODE_ENV=development` or `test`. The config refuses to load it in any other environment, and the router throws if it is built anyway. It is rate-limited per IP and subject to the Origin check.
