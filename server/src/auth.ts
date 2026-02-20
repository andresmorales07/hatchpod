import type { IncomingMessage, ServerResponse } from "node:http";
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

// ── Rate limiter ──

const MAX_FAILED_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const failedAttempts = new Map<string, number[]>();

// Clean up stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, timestamps] of failedAttempts) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) failedAttempts.delete(key);
    else failedAttempts.set(key, recent);
  }
}, 5 * 60 * 1000).unref();

const MAX_TRACKED_IPS = 10_000;

function recordFailedAttempt(ip: string): void {
  if (failedAttempts.size >= MAX_TRACKED_IPS && !failedAttempts.has(ip)) {
    return; // Shed load rather than grow unbounded
  }
  const timestamps = failedAttempts.get(ip) ?? [];
  timestamps.push(Date.now());
  failedAttempts.set(ip, timestamps);
}

function isRateLimited(ip: string): boolean {
  const timestamps = failedAttempts.get(ip);
  if (!timestamps) return false;
  const cutoff = Date.now() - WINDOW_MS;
  const recent = timestamps.filter((t) => t > cutoff);
  failedAttempts.set(ip, recent);
  return recent.length >= MAX_FAILED_ATTEMPTS;
}

const TRUST_PROXY = process.env.TRUST_PROXY === "1";

function getClientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function authenticateRequest(req: IncomingMessage): boolean | "rate_limited" {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) return "rate_limited";
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    recordFailedAttempt(ip);
    return false;
  }
  const valid = safeCompare(auth.slice(7), API_PASSWORD!);
  if (!valid) recordFailedAttempt(ip);
  return valid;
}

export function authenticateToken(token: string, ip: string): boolean | "rate_limited" {
  if (isRateLimited(ip)) return "rate_limited";
  const valid = safeCompare(token, API_PASSWORD!);
  if (!valid) recordFailedAttempt(ip);
  return valid;
}

export function getRequestIp(req: IncomingMessage): string {
  return getClientIp(req);
}

export function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

export function sendRateLimited(res: ServerResponse): void {
  res.writeHead(429, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "too many failed attempts, try again later" }));
}
