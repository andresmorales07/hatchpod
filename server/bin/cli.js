#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { argv, env, cwd } from "node:process";

// ── Parse flags ──────────────────────────────────────────────
const args = argv.slice(2);
const flags = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--port" && args[i + 1]) {
    flags.port = args[++i];
  } else if (arg === "--password" && args[i + 1]) {
    flags.password = args[++i];
  } else if (arg === "--root" && args[i + 1]) {
    flags.root = resolve(args[++i]);
  } else if (arg === "--host" && args[i + 1]) {
    flags.host = args[++i];
  } else if (arg === "--no-open") {
    flags.noOpen = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: claude-box-ui [options]

Options:
  --port <number>     Port to listen on (default: 8080, env: PORT)
  --password <string> API password (default: random, env: API_PASSWORD)
  --root <path>       Root directory for file browser (default: cwd, env: BROWSE_ROOT)
  --host <addr>       Bind address (default: 127.0.0.1, env: HOST)
  --no-open           Don't open the browser automatically
  -h, --help          Show this help message

Tip: Use API_PASSWORD env var instead of --password to avoid exposing
     the password in the process list.`);
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}\nRun with --help for usage.`);
    process.exit(1);
  }
}

// ── Validate port ────────────────────────────────────────────
const port = flags.port ?? env.PORT ?? "8080";
const portNum = parseInt(port, 10);
if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
  console.error(`Error: invalid port number: ${port}`);
  process.exit(1);
}

// ── Set env vars (flags > env > defaults) ────────────────────
const root = flags.root ?? env.BROWSE_ROOT ?? cwd();
const host = flags.host ?? env.HOST ?? "127.0.0.1";
const generated = !flags.password && !env.API_PASSWORD;
const password = flags.password ?? env.API_PASSWORD ?? randomBytes(16).toString("hex");

env.PORT = port;
env.HOST = host;
env.API_PASSWORD = password;
env.BROWSE_ROOT = root;
env.DEFAULT_CWD = root;

// ── Print startup info ───────────────────────────────────────
const url = `http://localhost:${port}`;
console.log(`\n  Web UI:    ${url}`);
console.log(`  Password:  ${generated ? password : "(set via flag or env)"}`);
console.log(`  Root:      ${root}`);
console.log(`  Bind:      ${host}\n`);

// ── Open browser (unless --no-open) ──────────────────────────
if (!flags.noOpen) {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs =
    process.platform === "win32" ? ["/c", "start", url] : [url];
  execFile(cmd, cmdArgs, (err) => {
    if (err) console.log(`  (Could not open browser automatically. Open ${url} manually.)`);
  });
}

// ── Start the server ─────────────────────────────────────────
await import("../dist/index.js");
