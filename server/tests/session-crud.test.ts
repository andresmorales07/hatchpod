import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, resetSessions, api, waitForStatus } from "./helpers.js";

beforeAll(async () => {
  await startServer();
  await resetSessions();
});

afterAll(async () => {
  await stopServer();
});

describe("Session CRUD", () => {
  it("creates a session with test provider and returns 201", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "Hello", provider: "test" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    // Test provider is fast — status may already be "running" or even "completed"
    expect(["starting", "running", "completed"]).toContain(body.status);
    expect(body.createdAt).toBeDefined();
  });

  it("creates an idle session without a prompt", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("idle");
  });

  it("lists sessions", async () => {
    const res = await api("/api/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2);
  });

  it("gets session details by ID", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "Detail test", provider: "test" }),
    });
    const { id } = await createRes.json();

    const session = await waitForStatus(id, "completed");

    expect(session.status).toBe("completed");
    expect(session.messages).toBeDefined();
    expect(Array.isArray(session.messages)).toBe(true);
    expect(session.permissionMode).toBe("default");
    expect(session.cwd).toBeDefined();
  });

  it("returns 404 for unknown session", async () => {
    const res = await api("/api/sessions/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("rejects invalid request body", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-string prompt", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: 42, provider: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates session with custom cwd", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "cwd test", provider: "test", cwd: "/tmp" }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();

    const session = await waitForStatus(id, "completed");
    expect(session.cwd).toBe("/tmp");
  });
});
