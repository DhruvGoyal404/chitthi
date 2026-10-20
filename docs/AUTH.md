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
  - `exp`, with 30 s of clock tolerance
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
