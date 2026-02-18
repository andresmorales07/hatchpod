import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";

const API_PASSWORD = process.env.API_PASSWORD;

export function requirePassword(): void {
  if (!API_PASSWORD) {
    console.error("FATAL: API_PASSWORD environment variable is required");
    process.exit(1);
  }
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authenticateRequest(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return safeCompare(auth.slice(7), API_PASSWORD!);
}

export function authenticateWs(url: URL): boolean {
  const token = url.searchParams.get("token");
  if (!token) return false;
  return safeCompare(token, API_PASSWORD!);
}

export function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}
