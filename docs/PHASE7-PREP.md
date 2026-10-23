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

## Known issue: flaky dark-mode accessibility e2e

- **Test:** `web/e2e/a11y.spec.ts`, "every screen meets WCAG 2.1 AA (dark)" (mobile project).
- **What happened:** once, locally, on a loaded machine (the run took 6.2 minutes against the usual 4–5), the test timed out after 10 s waiting for the search result button for the other user's handle in `openDm()`. It passed 4/4 on a re-run, and CI's e2e passed on the same commit. The trace was overwritten by the passing re-run.
- **Hypothesis:** a slow request against a fixed 10 s wait, not debounce.
  - `useUserSearch` has no debounce, and Playwright's `fill()` sets the whole handle in one change, so exactly one search request is made.
  - On a saturated machine, that request's database work (the rate-limit write, then the search) can exceed the API's 5 s statement and connection timeouts, which happened twice this phase. The resulting 5xx is retried twice by the client (about 1 s and 2 s of backoff), and the total passes Playwright's 10 s expect timeout.
- **Planned fix:**
  - `openDm()` waits for the `/api/users?q=` response and asserts it was 200, so a failure names its cause (a status, or no response) instead of "element not found".
  - Playwright keeps the trace of a failed attempt even when its retry passes, and CI uploads the report on every run, so the next occurrence leaves evidence.
  - The accessibility suite creates its DM through the API, because its subject is accessibility, not search. `screens.spec.ts` still covers search through the UI.
- **If it recurs after that:** read the kept trace before changing timeouts.
