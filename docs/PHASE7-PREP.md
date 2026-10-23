# Phase 7 prep notes

Collected during the Phase 6 review and the manual test pass. They are open items and constraints for the deploy phase, not decisions already made.

## Production configuration: what must hold

The deploy target is a plain Ubuntu VM behind Caddy, with no cloud-specific code.

- **`NODE_ENV=production` is pinned in the image and in the compose file**, never left to the environment.
  - Development switches are refused only under `production`.
  - `NODE_ENV=test` deliberately allows dev sign-in for test runs. A server started with `test` would accept `DEV_LOGIN=true`.
- **No development switch reaches production config.** The API refuses to start, naming the key, if any of these is set with `NODE_ENV=production`:
  - `DEV_LOGIN=true`
  - `RATE_LIMIT_AUTH`
  - `MEDIA_MIN_FREE_PERCENT`, `MEDIA_MIN_FREE_BYTES`
  - `GOOGLE_ISSUER`, `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_JWKS_URL`, `GITHUB_AUTH_URL`, `GITHUB_TOKEN_URL`, `GITHUB_API_URL`

  Tested in `api/test/production.test.ts`: the config, the production route table (no `/api/dev/*` routes), and the real process (exits 1 and never prints the database URL). Even so, keep these keys out of the production env files entirely: a refused start is a bad way to find a typo.
- **`MEDIA_DIR` is on the VM's data disk.** It must be an absolute path outside any web root, for example `/var/lib/chitthi/media` on the data volume, owned by the API's non-root user, mode 0700. It is required in production.
  - The disk guard (refuse uploads below max(15 %, 2 GB) free) measures the filesystem that holds `MEDIA_DIR`. Size that disk with headroom for the daily quotas (200 MB per user per day).
  - Back it up together with the database: rows without files, or files without rows, are only reconciled by the sweeper (orphans older than an hour are removed).
- **`TRUST_PROXY=1`** behind exactly one Caddy. **`PUBLIC_ORIGIN`** must be the public https origin, and the OAuth redirect URIs registered with Google and GitHub must match it.
- **`frame-ancestors 'none'`**, plus the page CSP, as response headers from Caddy. A meta CSP can't set `frame-ancestors`.

## Resolved: the "flaky" accessibility e2e

**Test:** `web/e2e/a11y.spec.ts`, "every screen meets WCAG 2.1 AA". It failed locally twice: once dark/mobile, once light/desktop. Each time the search result for the other user's handle never appeared within 10 s. CI never failed.

**The cause.** Confirmed with a kept trace.
- The new-conversation step searched only the **first 5 characters** of the handle (`axB_6…`).
- Search returns at most 8 people, sorted by handle: the Phase 5 anti-enumeration cap.
- Every local e2e run adds users to the dev database. When this was found, 12 users matched `axb_6`, so the test's own user could be cut off.
- In the trace the request returned 200 in 54 ms, with 8 people and not the expected one.
- That makes it data-dependent, not timing-dependent. It depends on the random first hex digit of the handle and on how many earlier runs ran against the same database. CI starts from a fresh database, so it never saw it.

**The first hypothesis was wrong.** It was "a slow request on a loaded machine against a fixed 10 s wait". The trace kept by the change below disproved it.

**Fixed at the end of Phase 6** (the e2e fix commit after these notes):
- The step searches the full handle, which is unique.
- `openDm()` waits for the `/api/users?q=` response and asserts it was 200, so a failing search names its cause.
- The accessibility suite creates its DM through the API, because its subject is accessibility, not search. `screens.spec.ts` covers search through the UI.
- Playwright keeps the trace of a failed attempt, and CI uploads the report on every run, so a failure that passes on retry still leaves evidence.

**Lesson for later suites.** Any e2e step that searches by a short prefix will eventually collide with leftovers in a long-lived dev database. Search by the full, random handle. The screenshot spec had the same bug with "meera" and was fixed the same way.
