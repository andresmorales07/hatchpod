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
    expect(session.cwd).toBeDefined();
    expect(session.source).toBe("api");
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

  it("creates session with custom cwd within workspace", async () => {
    const cwd = process.cwd(); // BROWSE_ROOT defaults to cwd
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "cwd test", provider: "test", cwd }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();

    const session = await waitForStatus(id, "completed");
    expect(session.cwd).toBe(cwd);
  });

  it("rejects cwd outside workspace", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "cwd test", provider: "test", cwd: "/tmp" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cwd must be within the workspace");
  });

  it("GET /api/providers returns registered providers", async () => {
    const res = await api("/api/providers");
    expect(res.status).toBe(200);
    const providers = await res.json();
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThanOrEqual(1);
    // In test env, both claude and test should be registered
    const ids = providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("test");
  });

  it("GET /api/sessions returns sessions with provider and new fields", async () => {
    // Create a session first
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "test listing", provider: "test" }),
    });
    expect(createRes.status).toBe(201);

    // List sessions
    const listRes = await api("/api/sessions");
    expect(listRes.status).toBe(200);
    const sessions = await listRes.json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    const session = sessions.find((s: { provider: string }) => s.provider === "test");
    expect(session).toBeDefined();
    expect(session).toHaveProperty("provider");
    expect(session).toHaveProperty("slug");
    expect(session).toHaveProperty("summary");
    expect(session).toHaveProperty("lastModified");
  });

  it("accepts effort in POST /api/sessions body", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test", effort: "low" }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects invalid effort in POST /api/sessions body", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: "test", effort: "extreme" }),
    });
    expect(res.status).toBe(400);
  });
});
