# Sign-in, sessions and accounts

Chitthi has no passwords. People sign in with Google or GitHub. A development-only shortcut (`DEV_LOGIN`) signs in by handle and is refused outside `NODE_ENV=development|test`.

Code: [`api/src/oauth/`](../api/src/oauth), [`api/src/sessions.ts`](../api/src/sessions.ts) and [`api/src/devLogin.ts`](../api/src/devLogin.ts). Tests: [`api/test/oauth.db.test.ts`](../api/test/oauth.db.test.ts), which runs against local mock providers ([`mockProviders.ts`](../api/test/mockProviders.ts)).

## Configuration

| Key | Meaning |
|---|---|
| `PUBLIC_ORIGIN` | The origin the browser uses, e.g. `https://chitthi.example`. Redirect URIs are `<PUBLIC_ORIGIN>/api/auth/{google,github}/callback`. It must be one of `WEB_ORIGINS`, and defaults to the first of them. |
| `TRUST_PROXY` | `0` (the API is reached directly) or `1` (behind exactly one reverse proxy, such as Caddy). Only then is `X-Forwarded-For` believed, and only its last hop. Rate limits per IP depend on this. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Both or neither. With neither, the provider is hidden. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Both or neither. |
| `GOOGLE_*_URL`, `GOOGLE_ISSUER`, `GITHUB_*_URL` | Endpoint overrides for tests only. The config refuses them in production. |

The secrets are registered with the log scrubber. Config errors name the key, never the value. The API reads `.env` and then `api/.env`.

## The flows

**Google (OpenID Connect):** authorization code + PKCE S256 + `state` + `nonce`, scope `openid email profile`.

- The ID token is verified with `jose` against Google's JWKS, cached by `createRemoteJWKSet`. The checks are:
  - signature (RS256 only)
  - `iss` (`https://accounts.google.com` or `accounts.google.com`)
  - `aud` = our client id
  - `exp` and `iat`, with 60 s of clock tolerance either way: `iat` may be up to a minute in the future, and the token may be no older than one hour (`maxTokenAge`). Without that option jose never checks `iat`.
  - `alg: none` and HS256 tokens keyed with the client secret (algorithm confusion) are refused; tests cover both.
  - `nonce` = the one stored for this flow
- `email_verified` must be true.

**GitHub (OAuth 2):** authorization code + PKCE S256 + `state`, scope `read:user user:email`.

- The account must have a primary email that is verified (`/user/emails`).
- The access token is used for those two reads and then dropped.

**Both:**

- **What is stored.** No refresh token, and no access token. The account keeps only the provider's subject id, the verified email, the name and an https avatar URL.
- **`state`.** 32 random bytes. Only its SHA-256 is stored, in `oauth_flows`, along with the PKCE verifier and the nonce. It expires in 10 minutes and is consumed with `DELETE … RETURNING`, so a replay finds nothing.
- **Login CSRF defence.** The same state is set as an `HttpOnly`, `SameSite=Lax` cookie scoped to `/api/auth`. The callback refuses a `state` that does not match this browser's cookie.
- **`?next=`.** It only accepts in-app paths (`/…`, never `//…` or a backslash).
- **Failures.** They redirect to `/signin?error=<code>&provider=<p>` (or `/account?…` for linking), and the page explains them in plain words. Codes: `cancelled`, `state_mismatch`, `state_invalid`, `invalid_id_token`, `email_unverified`, `token_exchange_failed`, `provider_unreachable`, `account_exists`, `account_disabled`, plus the linking codes below.

## First sign-in (onboarding)

A provider identity seen for the first time does not create a user. It creates a `pending_signups` row (30 minutes; the browser holds a token whose hash is stored), and the browser goes to `/welcome`.

- The page prefills the display name and avatar from the provider, and suggests a free handle derived from the email.
- `POST /api/auth/onboarding {handle, displayName}` creates everything in one transaction: it consumes the pending row, then inserts the user and the identity.
- A taken or reserved handle (case-insensitive, same rules as everywhere) rolls the transaction back, so the person can pick again.
- The email is re-checked inside that transaction.

## Linking, and never by email

- **Email clashes are refused.** A new identity whose verified email is already used by an active account is refused with `account_exists`, never merged. A provider vouching for an address is not proof that the person owns the existing account; the risk is account takeover through a provider that verifies emails loosely. The person signs in the way they did before and links the new provider explicitly.
- **How linking works.** It starts from the Account page (`GET /api/auth/:provider/link`, signed in). It is refused with:
  - `identity_in_use`: that provider account belongs to another Chitthi account;
  - `provider_already_linked`: one identity per provider per account;
  - `account_exists`: the email belongs to another account;
  - `link_session_changed`: the browser's session changed between start and callback.

## Sessions

- **Tokens.** Each session is a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production). Only its SHA-256 is stored. Sessions last 7 days.
- **Rotation.** Every sign-in (provider callback, onboarding, dev login) revokes the session the browser arrived with before issuing a new one, so a planted token never survives a sign-in (session fixation).
- **Signing out.**
  - `POST /api/auth/logout` revokes this session.
  - `POST /api/auth/logout-all` revokes every session of the account ("Sign out everywhere").
  - A trigger on `sessions` notifies the realtime server, which disconnects the affected sockets at once. This is tested for both routes.
- **Origin check.** Every state-changing request needs an allow-listed `Origin`, and so does the WebSocket upgrade.

## Rate limits

All limits use `rate-limiter-flexible`'s Postgres store (the `rate_limits` table), so they hold across restarts and API instances without a new service. If the store is unreachable, the limiter lets the request through and logs it.

When a limit stops a request, the API answers `429` with `Retry-After`, `error.code = "rate_limited"`, `error.details.limit` (which limit), and a calm sentence the UI shows as it is. Defaults are in [`api/src/limits.ts`](../api/src/limits.ts):

| Limit | Key | Default | Notes |
|---|---|---|---|
| Sign-in | client IP | 30 / 10 min | OAuth start and callback, onboarding, dev sign-in. Listing providers and identities is exempt. The IP comes from `TRUST_PROXY`. |
| Send burst | user | 30 / 10 s | Sends, edits and deletes. |
| Send sustained | user | 400 / 10 min | Checked after the burst limit. A fast typist sends one message every couple of seconds, far below either. |
| New DMs | user | 50 / day | Only creating a DM counts; reopening an existing one is always allowed. |
| Group creation | user | 20 / day | |
| Member adds | user | 300 / day | A new group's initial members count too. |
| Handle search | user | 60 / min | Shared with exact handle lookups. Needs at least 3 characters and returns at most 8 people, so the directory can't be listed. |
| Socket connects | user | 30 / min | Checked in the handshake. |

In the web app, an optimistic send that gets a 429 becomes "failed" with the server's explanation and a Retry button. A retry uses the same client message id, so it is stored at most once. Other screens show the message where the action was taken.

## Blocking

A user can block and unblock another: from the contact info of a DM (after a confirmation that says what it does), or from the Account page, which lists everyone they have blocked. Routes: `GET /api/blocks`, `PUT /api/blocks/:userId`, `DELETE /api/blocks/:userId`.

What a block does, in every path (REST and socket), tested in [`api/test/blocks.db.test.ts`](../api/test/blocks.db.test.ts):

| Effect | Where it is enforced |
|---|---|
| Neither person can send or edit in their DM. Deleting your own message for everyone stays allowed. History stays readable. | The database trigger `messages_reject_blocked_direct`, under the conversation lock, so no seq is lost. |
| A new DM can't be started in either direction. An existing one still opens. | `findOrCreateDirect`. |
| Someone who blocked you can't be added by you to a new or existing group. | `createGroup`, `addMember`. |
| Someone who blocked you doesn't appear in your handle search or exact lookup. | `searchUsers`, `findUserByHandle`. |
| No presence, last seen or typing in either direction, including in groups they share. | The realtime presence (events, snapshots, introductions) and typing relay. A block or unblock takes effect at once through `user_blocks_notify`. |

**The blocker is told plainly** ("You blocked this person. Unblock them to send messages."), because they can undo it. **The blocked person gets a neutral refusal** ("You can't message this person."). They can still infer the block from it, as in any messenger; hiding a refusal would mean pretending to deliver messages that are thrown away, which this app does not do.

**Product decision: refuse, don't silently drop.** The visible refusal is a deliberate choice, recorded here so it isn't mistaken for an oversight.

**Why:**
- **Simpler and honest.** The sender's app never shows a message as sent when it wasn't. Ticks, receipts and the outbox need no special case.
- **It keeps the sequence model intact.** A refused send never gets a `seq`: the database refuses it under the conversation lock, and the rollback takes the number back. So every conversation stays gap-free and identical for every reader.

**The alternative, for later.** Some messengers silently drop the blocked person's messages: the sender sees them as sent, the recipient never receives them. That hides the block better.

**The cost of that alternative:**
- Either the dropped message is stored with a `seq` that only one participant can see, which breaks "every member reads the same gap-free sequence" (see [SCHEMA.md](SCHEMA.md));
- or it lives in a separate shadow store outside the sequence, with its own ticks that pretend to be delivered.

Either way, delivery state starts to lie. If it is ever wanted, design it as its own phase with its own invariants. It is not a wording change.

**Groups they already share are unaffected:** both stay members, both still send there, and each sees the other's group messages. The reasons:

- A group belongs to all its members. One member's block can't remove another member, or silently filter what the rest of the group sees and replies to. Hiding some messages from one reader would make that reader's view of the conversation incoherent: replies to messages they can't see, and unread counts that disagree with what is shown.
- Every member reads the same `seq` sequence. Holes for one reader would break the gap-free model ([SCHEMA.md](SCHEMA.md)).
- What a block protects against is *new contact*: DMs, being added to groups, being found, and being watched (presence, typing). All of that is enforced.
- To get away from someone in a group, leave it, or ask an admin to remove them.

## Deleting an account

From the Account page. The page lists exactly what happens and asks for the handle to be typed again. `DELETE /api/me {confirmHandle, eraseMessages}` does it all in one transaction ([`api/src/repo/account.ts`](../api/src/repo/account.ts)):

- **Sessions and sockets.** The account is disabled, so every socket disconnects at once (the existing `users_notify_disabled` trigger). Its sessions, identities, blocks (both ways) and in-progress OAuth flows are deleted.
- **The profile is emptied, not removed.** Messages, memberships and read markers point at the user row, so it stays:
  - the handle becomes `del_<random hex>`;
  - the name becomes "Deleted user";
  - the avatar is cleared;
  - `deleted_at` is set.
- **Groups.** Every active group membership closes with `left_reason = 'deleted'`, after a `member_left` notice, so the window ends exactly there. A group the user owned passes to the longest-standing admin, or else the longest-standing member, with an `owner_changed` notice.
- **Direct conversations** keep both members, so the other person keeps the whole history. The database refuses new messages there (`messages_reject_deleted_direct`, under the conversation lock: no seq gap), and the UI says why. A new DM with a deleted account can't be started.
- **Messages** stay for everyone else by default, with the author shown as "Deleted user".
- **Erasing messages (opt-in).** With `eraseMessages`, every text message the user sent becomes a tombstone, exactly as delete-for-everyone does: the body and its hash are erased, while the row and its seq stay. Open chats see it live as an edit.
- **The handle is held for 30 days** in `handle_holds`, which the handle trigger checks, so nobody can take over the name and pass as the person who just left. Someone trying it gets the ordinary "That handle is taken", which doesn't reveal that the account was deleted.
- **Tick calculations** ignore deleted accounts.

**Invariants still hold**, as tested in [`api/test/account.db.test.ts`](../api/test/account.db.test.ts):

- seqs stay `1..last_seq` with no gaps in every affected conversation;
- unread counts match the definition, recomputed from the rows, for everyone who remains;
- the deleted member's window ends at its `member_left` notice.

Signing in again with the same Google or GitHub account afterwards starts a brand-new account; nothing links it to the deleted one.

## Security headers and CSP

- **API.** Every API response carries helmet's defaults. Tested on JSON, 4xx, 5xx and the Origin refusal in [`api/test/headers.test.ts`](../api/test/headers.test.ts):
  - `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `-Resource-Policy: same-origin`, `Origin-Agent-Cluster`, with `X-Powered-By` removed;
  - its own CSP, `default-src 'none'; frame-ancestors 'none'`. The API only answers with JSON and redirects.
- **Web app.** The production build carries a CSP `<meta>` tag ([`web/vite.config.ts`](../web/vite.config.ts), `WEB_CSP`). The dev server leaves it out, because hot reload needs inline scripts. The policy:
  - same-origin scripts, styles, fonts and connections (WebSocket included);
  - images from same-origin, `data:` and `https:`, for provider avatars;
  - `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`;
  - the build has no inline scripts or styles.

  The e2e suite runs against the production build, so every Playwright test runs under this policy. [`web/e2e/csp.spec.ts`](../web/e2e/csp.spec.ts) walks every screen and fails on any CSP violation. It also checks that an injected inline script is refused.
- **Still to come.** A meta CSP can't set `frame-ancestors`. The reverse proxy will send the same policy as a header, plus `frame-ancestors 'none'`, in the deploy phase.
- **Dev sign-in.** It stays development and test only:
  - the config refuses `DEV_LOGIN` in any other `NODE_ENV`;
  - building the router there throws;
  - its routes, including the test-only `/api/dev/pending-signup`, are not mounted unless it is enabled;
  - the sign-in page shows the handle form only when `/api/auth/providers` reports `dev: true`.
