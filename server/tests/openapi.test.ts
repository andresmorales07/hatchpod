import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, api, rawFetch } from "./helpers.js";

beforeAll(async () => {
  await startServer();
});

afterAll(async () => {
  await stopServer();
});

describe("GET /api/openapi.json", () => {
  it("returns a valid OpenAPI 3.1 spec", async () => {
    const res = await rawFetch("/api/openapi.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("Hatchpod API");
    expect(body.info.version).toBeDefined();
  });

  it("includes all expected paths", async () => {
    const res = await rawFetch("/api/openapi.json");
    const body = await res.json();
    const paths = Object.keys(body.paths);

    expect(paths).toContain("/healthz");
    expect(paths).toContain("/api/config");
    expect(paths).toContain("/api/providers");
    expect(paths).toContain("/api/sessions");
    expect(paths).toContain("/api/sessions/{id}");
    expect(paths).toContain("/api/sessions/{id}/history");
    expect(paths).toContain("/api/sessions/{id}/messages");
    expect(paths).toContain("/api/browse");
  });

  it("defines the bearerAuth security scheme", async () => {
    const res = await rawFetch("/api/openapi.json");
    const body = await res.json();
    const schemes = body.components?.securitySchemes;
    expect(schemes).toBeDefined();
    expect(schemes.bearerAuth).toBeDefined();
    expect(schemes.bearerAuth.type).toBe("http");
    expect(schemes.bearerAuth.scheme).toBe("bearer");
  });

  it("is accessible without authentication", async () => {
    const res = await rawFetch("/api/openapi.json");
    expect(res.status).toBe(200);
  });

  it("includes WebSocket documentation in info.description", async () => {
    const res = await rawFetch("/api/openapi.json");
    const body = await res.json();
    expect(body.info.description).toContain("WebSocket");
  });

  it("includes registered component schemas", async () => {
    const res = await rawFetch("/api/openapi.json");
    const body = await res.json();
    const schemas = body.components?.schemas;
    expect(schemas).toBeDefined();
    expect(schemas.CreateSessionRequest).toBeDefined();
    expect(schemas.NormalizedMessage).toBeDefined();
    expect(schemas.ErrorResponse).toBeDefined();
    expect(schemas.HealthResponse).toBeDefined();
  });
});

describe("GET /api/docs", () => {
  it("returns HTML with Scalar script tag", async () => {
    const res = await rawFetch("/api/docs");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("@scalar/api-reference");
    expect(html).toContain("/api/openapi.json");
  });

  it("is accessible without authentication", async () => {
    const res = await rawFetch("/api/docs");
    expect(res.status).toBe(200);
  });

  it("sets CSP to allow cdn.jsdelivr.net", async () => {
    const res = await rawFetch("/api/docs");
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeDefined();
    expect(csp).toContain("cdn.jsdelivr.net");
  });
});

describe("POST /api/sessions validation (Zod error messages in HTTP responses)", () => {
  it("returns 'prompt must be a string' for non-string prompt", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: 42 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("prompt must be a string");
  });

  it("returns 'invalid permissionMode' for unknown mode", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ permissionMode: "yolo" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid permissionMode");
  });

  it("returns 'resumeSessionId must be a valid UUID' for bad UUID", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ resumeSessionId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("resumeSessionId must be a valid UUID");
  });

  it("returns 'invalid cwd' for cwd with null byte", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: "/foo\0bar" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid cwd");
  });

  it("rejects non-array allowedTools", async () => {
    const res = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ allowedTools: "Bash" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("auth still required on data endpoints", () => {
  it("GET /api/sessions requires auth", async () => {
    const res = await rawFetch("/api/sessions");
    expect(res.status).toBe(401);
  });

  it("GET /api/sessions works with auth", async () => {
    const res = await api("/api/sessions");
    expect(res.status).toBe(200);
  });
});
