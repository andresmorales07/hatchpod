import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, resetSessions, rawFetch, getBaseUrl } from "./helpers.js";

beforeAll(async () => {
  await startServer();
  await resetSessions();
});

afterAll(async () => {
  await stopServer();
});

describe("REST API Authentication", () => {
  it("allows /healthz without auth", async () => {
    const res = await rawFetch("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body as { status: string }).status).toBe("ok");
  });

  it("rejects GET /api/sessions without auth header", async () => {
    const res = await rawFetch("/api/sessions");
    expect(res.status).toBe(401);
  });

  it("rejects POST /api/sessions with wrong bearer token", async () => {
    const res = await fetch(`${getBaseUrl()}/api/sessions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "test", provider: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects GET /api/sessions with malformed auth header", async () => {
    const res = await fetch(`${getBaseUrl()}/api/sessions`, {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects GET /api/sessions/:id without auth", async () => {
    const res = await rawFetch("/api/sessions/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(401);
  });
});
