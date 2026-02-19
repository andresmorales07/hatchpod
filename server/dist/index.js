import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { requirePassword } from "./auth.js";
import { handleRequest } from "./routes.js";
import { handleWsConnection, extractSessionIdFromPath } from "./ws.js";
// Require API_PASSWORD on startup
requirePassword();
const PORT = parseInt(process.env.PORT ?? "8080", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const MIME_TYPES = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
};
async function serveStatic(pathname) {
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
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            console.error(`Static file error for ${filePath}:`, err);
        }
        return null;
    }
}
const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    // API and health routes
    if (pathname === "/healthz" || pathname.startsWith("/api/")) {
        await handleRequest(req, res);
        return;
    }
    // Static file serving
    const result = await serveStatic(pathname === "/" ? "/index.html" : pathname);
    if (result) {
        res.writeHead(200, { "Content-Type": result.contentType });
        res.end(result.data);
        return;
    }
    // SPA fallback: serve index.html for paths without file extensions
    const ext = extname(pathname);
    if (!ext) {
        const indexResult = await serveStatic("/index.html");
        if (indexResult) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(indexResult.data);
            return;
        }
    }
    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
});
// WebSocket upgrade handling — authentication happens via first message, not URL
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // Extract session ID from path (auth happens after upgrade via first message)
    const sessionId = extractSessionIdFromPath(url.pathname);
    if (!sessionId) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        handleWsConnection(ws, sessionId);
    });
});
server.listen(PORT, HOST, () => {
    console.log(`hatchpod API server listening on ${HOST}:${PORT}`);
});
