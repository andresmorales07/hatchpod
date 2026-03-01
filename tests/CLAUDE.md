## Testing Strategy

### Automated tests (Playwright)

Playwright e2e tests cover the API endpoints, web UI, WebSocket connections, static file serving, session message delivery, and the embedded terminal. The config (`playwright.config.ts`) defines seven test projects:

- `api` → `http://localhost:8080` (bearer token)
- `web-ui` → `http://localhost:8080` (browser)
- `web-ui-firefox` → `http://localhost:8080` (browser)
- `ws` → `http://localhost:8080` (WebSocket)
- `static` → `http://localhost:8080` (static files)
- `terminal` → `http://localhost:8080` (embedded terminal WebSocket)
- `session-delivery` → `http://localhost:8080` (test provider, requires `ENABLE_TEST_PROVIDER=1`)

Ports are configurable via `API_PORT` env var (defaults to 8080). When running tests inside hatchpod itself, use offset ports to avoid conflicts with the host services (e.g., `API_PORT=18080`).

**Important:** Always run tests by building and running the Docker container first — do not run them against an externally running instance.

**Rate limiter and test isolation:** The API rate limiter tracks failed auth attempts in memory (10 failures / 15 min per IP). Always use a **fresh container** for each Playwright run — running the suite multiple times against the same container exhausts the limit and subsequent runs get 429 even with the correct password. Always `docker rm -f hatchpod-test` before starting a new run.

**`API_PASSWORD` env inheritance:** When running inside hatchpod, `API_PASSWORD` is already set to the production password. You must explicitly pass `API_PASSWORD=changeme` in step 2; otherwise tests authenticate against the test container using the wrong password and cascade-fail with 401.

```bash
# 1. Build and run the container (use offset ports when running inside hatchpod)
docker build -t hatchpod:latest .
docker run -d --name hatchpod-test \
  -p 12222:2222 -p 18080:8080 \
  --runtime runc \
  -e API_PASSWORD=changeme \
  -e ENABLE_TEST_PROVIDER=1 \
  hatchpod:latest

# 2. Run tests (pass offset ports AND API_PASSWORD — don't inherit the production password)
npm install
API_PORT=18080 API_PASSWORD=changeme npx playwright test

# 3. Clean up
docker rm -f hatchpod-test
```

### Test files

- **`tests/api.spec.ts`** — REST API: healthz, auth, session CRUD, browse endpoint (directory listing, path traversal rejection, auth)
- **`tests/web-ui.spec.ts`** — Web UI: login page rendering, authentication flow
- **`tests/ws.spec.ts`** — WebSocket: connection lifecycle, message exchange
- **`tests/static.spec.ts`** — Static file serving: index.html, assets, SPA fallback
- **`tests/terminal.spec.ts`** — Embedded terminal: WebSocket connection, pty I/O, session lifecycle
- **`tests/session-delivery.spec.ts`** — Session message delivery pipeline: push-mode flow, lifecycle transitions, follow-up messages, reconnect replay, multi-client broadcast, session ID remap, interrupt, tool approval, thinking deltas, slash commands. Requires `ENABLE_TEST_PROVIDER=1`

See `server/tests/` for Vitest unit tests.

### Manual verification

1. **Build** — `make build` must complete without errors.
2. **Startup** — `make up` then `docker compose ps` should show the container as healthy (healthcheck curls `http://localhost:8080/healthz`).
3. **SSH access** — `make ssh` (or `ssh -p 2222 hatchpod@localhost`) should connect and drop into a bash shell.
4. **Mosh access** — `make mosh` (or `mosh --ssh='ssh -p 2222' hatchpod@localhost`) should connect and drop into a bash shell. Verify the session survives a brief network interruption (e.g., sleep/wake laptop).
5. **Claude Code** — run `claude` inside the container and follow the login link to authenticate.
6. **Volume persistence** — `make down && make up`, then verify files in `~/workspace` and `~/.claude` survived the restart.
7. **Docker-in-Docker** — `make docker-test` runs `docker run hello-world` inside the container (requires Sysbox on host).
8. **CI** — GitHub Actions runs `docker compose build` and verifies the image starts and passes its healthcheck. Note: Sysbox is not available in CI, so dockerd will not start there.
9. **Tailscale VPN** — set `TS_AUTHKEY` in `.env`, restart, verify `tailscale status` shows the node connected to the tailnet.
10. **Dotfiles** — set `DOTFILES_REPO` in `.env`, start a fresh container (no existing `home` volume), verify `~/dotfiles` is cloned and install script was run.
