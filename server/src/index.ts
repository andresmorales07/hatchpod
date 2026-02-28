import { createServer as createHttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { requirePassword, getRequestIp } from "./auth.js";
import { handleRequest } from "./routes.js";
import { handleWsConnection, extractSessionIdFromPath } from "./ws.js";
import { handleTerminalWsConnection } from "./terminal-ws.js";
import { initWatcher } from "./sessions.js";
import { getProvider } from "./providers/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string): Promise<{ data: Buffer; contentType: string } | null> {
  // Prevent directory traversal
  const safePath = pathname.replace(/\.\./g, "");
  const filePath = join(PUBLIC_DIR, safePath);

  // Ensure resolved path is within PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    return { data, contentType };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Static file error for ${filePath}:`, err);
    }
    return null;
  }
}

const BASE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function buildCsp(nonce?: string): string {
  const scriptSrc = nonce
    ? `'self' 'nonce-${nonce}' blob:`
    : "'self' blob:";
  return (
    `default-src 'self'; script-src ${scriptSrc}; worker-src 'self' blob:; ` +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  );
}

const DEFAULT_CSP = buildCsp();

function setSecurityHeaders(res: import("node:http").ServerResponse): void {
  for (const [key, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
  res.setHeader("Content-Security-Policy", DEFAULT_CSP);
}

/** Inject a per-request nonce into index.html script tags and return nonce-based CSP. */
function serveIndex(
  res: import("node:http").ServerResponse,
  data: Buffer,
): void {
  const nonce = randomBytes(16).toString("base64");
  const html = data.toString("utf-8").replace(/<script\b/g, (m) => `${m} nonce="${nonce}"`);
  res.setHeader("Content-Security-Policy", buildCsp(nonce));
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
  res.end(html);
}

export function createApp() {
  // Initialize the SessionWatcher with the default provider adapter.
  // This starts polling JSONL session files for new messages.
  initWatcher(getProvider("claude"));

  const server = createHttpServer(async (req, res) => {
    try {
      setSecurityHeaders(res);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      // API and health routes
      if (pathname === "/healthz" || pathname.startsWith("/api/")) {
        await handleRequest(req, res);
        return;
      }

      // Static file serving
      const isIndex = pathname === "/" || pathname === "/index.html";
      const result = await serveStatic(isIndex ? "/index.html" : pathname);
      if (result) {
        if (isIndex) {
          serveIndex(res, result.data);
          return;
        }
        // Hashed assets (Vite content-hashed filenames) can be cached forever;
        // everything else must revalidate so updates take effect.
        const cacheControl = pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        res.writeHead(200, { "Content-Type": result.contentType, "Cache-Control": cacheControl });
        res.end(result.data);
        return;
      }

      // SPA fallback: serve index.html for paths without file extensions
      const ext = extname(pathname);
      if (!ext) {
        const indexResult = await serveStatic("/index.html");
        if (indexResult) {
          serveIndex(res, indexResult.data);
          return;
        }
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      console.error("Unhandled error in request handler:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    }
  });

  // WebSocket upgrade handling — authentication happens via first message, not URL
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 }); // 1 MB

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Origin validation — block cross-origin WebSocket hijacking from browsers.
    // Non-browser clients may omit the Origin header; auth via first message is the primary gate.
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host;
      try {
        const originHost = new URL(origin).host;
        if (host && originHost !== host) {
          console.warn(`WebSocket rejected: cross-origin from ${origin} (expected host: ${host})`);
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch (err) {
        console.warn(`WebSocket rejected: malformed origin "${origin}":`, err);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    const ip = getRequestIp(req);

    // Terminal WebSocket — /api/terminal/stream
    if (url.pathname === "/api/terminal/stream") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalWsConnection(ws, ip);
      });
      return;
    }

    // Session WebSocket — /api/sessions/:id/stream
    const sessionId = extractSessionIdFromPath(url.pathname);
    if (!sessionId) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleWsConnection(ws, sessionId, ip);
    });
  });

  return { server, wss };
}

// Auto-listen when run directly (node dist/index.js) or via CLI (HATCHPOD_AUTO_LISTEN=1)
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun || process.env.HATCHPOD_AUTO_LISTEN === "1") {
  requirePassword();
  const PORT = parseInt(process.env.PORT ?? "8080", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";
  const { server } = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`hatchpod API server listening on ${HOST}:${PORT}`);
  });
}
