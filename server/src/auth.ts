import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";

const API_PASSWORD = process.env.API_PASSWORD;

export function requirePassword(): void {
  if (!API_PASSWORD) {
    console.error("FATAL: API_PASSWORD environment variable is required");
    process.exit(1);
  }
}

export function authenticateRequest(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === API_PASSWORD;
}

export function authenticateWs(url: URL): boolean {
  const token = url.searchParams.get("token");
  return token === API_PASSWORD;
}

export function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}
