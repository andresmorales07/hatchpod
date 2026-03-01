## Standalone Usage (without Docker)

The `server/` directory is a publishable npm package. Users with Claude Code installed locally can run:

```bash
npx hatchpod-api --password mysecret
```

This starts the API server and web UI on `http://localhost:8080`. The `--root` flag sets the file browser root (defaults to cwd). See `npx hatchpod-api --help` for all options.

The container sets `BROWSE_ROOT` and `DEFAULT_CWD` env vars explicitly to `/home/hatchpod/workspace`. When running standalone, these default to `process.cwd()`.

## Developing Inside Hatchpod Itself

When Claude Code runs inside the hatchpod container, the s6-managed API server is already running on port 8080 with its own `API_PASSWORD` (inherited from the container environment). To test changes to `server/src/` or `server/ui/src/` without interfering with the production server:

```bash
# Detect: check if s6 API server is already on port 8080
curl -s http://localhost:8080/healthz | grep -q '"status":"ok"'

# Start a separate API server on a different port with a known password
cd server && npm run build && API_PASSWORD=test PORT=9080 node dist/index.js &

# Open http://localhost:9080 to test (password: "test")
# Or use Vite dev server pointed at the test API:
cd server/ui && VITE_API_PORT=9080 npx vite --host &
```

The test server on port 9080 can serve CLI session history and test-provider sessions, but **cannot run Claude sessions** (it lacks the Claude API credentials that the s6-managed server inherits from the container environment). To test live Claude sessions, use the s6-managed server on port 8080.

## Build Conventions

- `server/dist/` and `server/public/` are gitignored build artifacts. After modifying `server/src/`, run `cd server && npm run build` locally before `npm start`. The Dockerfile rebuilds both at container build time; `prepublishOnly` rebuilds them before `npm publish`.
- **ESLint** is configured in both `server/` and `server/ui/` using ESLint v9 flat config with typescript-eslint. Run `npm run lint` to check and `npm run lint:fix` to auto-fix. The UI config includes `eslint-plugin-react-hooks` and `eslint-plugin-react-refresh`.
