import { timingSafeEqual } from "node:crypto";
const API_PASSWORD = process.env.API_PASSWORD;
export function requirePassword() {
    if (!API_PASSWORD) {
        console.error("FATAL: API_PASSWORD environment variable is required");
        process.exit(1);
    }
}
function safeCompare(a, b) {
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
// ── Rate limiter ──
const MAX_FAILED_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const failedAttempts = new Map();
// Clean up stale entries every 5 minutes
setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, timestamps] of failedAttempts) {
        const recent = timestamps.filter((t) => t > cutoff);
        if (recent.length === 0)
            failedAttempts.delete(key);
        else
            failedAttempts.set(key, recent);
    }
}, 5 * 60 * 1000).unref();
function recordFailedAttempt(ip) {
    const timestamps = failedAttempts.get(ip) ?? [];
    timestamps.push(Date.now());
    failedAttempts.set(ip, timestamps);
}
function isRateLimited(ip) {
    const timestamps = failedAttempts.get(ip);
    if (!timestamps)
        return false;
    const cutoff = Date.now() - WINDOW_MS;
    const recent = timestamps.filter((t) => t > cutoff);
    failedAttempts.set(ip, recent);
    return recent.length >= MAX_FAILED_ATTEMPTS;
}
function getClientIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string")
        return forwarded.split(",")[0].trim();
    return req.socket.remoteAddress ?? "unknown";
}
export function authenticateRequest(req) {
    const ip = getClientIp(req);
    if (isRateLimited(ip))
        return "rate_limited";
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
        recordFailedAttempt(ip);
        return false;
    }
    const valid = safeCompare(auth.slice(7), API_PASSWORD);
    if (!valid)
        recordFailedAttempt(ip);
    return valid;
}
export function authenticateToken(token, ip) {
    if (ip && isRateLimited(ip))
        return "rate_limited";
    const valid = safeCompare(token, API_PASSWORD);
    if (!valid && ip)
        recordFailedAttempt(ip);
    return valid;
}
export function getRequestIp(req) {
    return getClientIp(req);
}
export function sendUnauthorized(res) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
}
export function sendRateLimited(res) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "too many failed attempts, try again later" }));
}
