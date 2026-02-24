import { describe, it, expect } from "vitest";
import {
  CreateSessionRequestSchema,
  NormalizedMessageSchema,
  isPathContained,
} from "../src/schemas/index.js";

describe("CreateSessionRequestSchema", () => {
  it("accepts a valid request with all fields", () => {
    const result = CreateSessionRequestSchema.safeParse({
      prompt: "Hello",
      permissionMode: "default",
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      cwd: "/home/user/project",
      allowedTools: ["Bash", "Read"],
      resumeSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object (all fields optional)", () => {
    const result = CreateSessionRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects non-string prompt", () => {
    const result = CreateSessionRequestSchema.safeParse({ prompt: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("prompt must be a string");
    }
  });

  it("rejects invalid permissionMode", () => {
    const result = CreateSessionRequestSchema.safeParse({ permissionMode: "yolo" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("invalid permissionMode");
    }
  });

  it("accepts all valid permission modes", () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan", "delegate", "dontAsk"]) {
      const result = CreateSessionRequestSchema.safeParse({ permissionMode: mode });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid resumeSessionId", () => {
    const result = CreateSessionRequestSchema.safeParse({ resumeSessionId: "not-a-uuid" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("resumeSessionId must be a valid UUID");
    }
  });

  it("rejects cwd with null byte", () => {
    const result = CreateSessionRequestSchema.safeParse({ cwd: "/foo\0bar" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("invalid cwd");
    }
  });

  it("rejects non-string cwd", () => {
    const result = CreateSessionRequestSchema.safeParse({ cwd: 123 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("invalid cwd");
    }
  });
});

describe("NormalizedMessageSchema", () => {
  it("accepts a valid user message", () => {
    const result = NormalizedMessageSchema.safeParse({
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
      index: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid assistant message with thinking duration", () => {
    const result = NormalizedMessageSchema.safeParse({
      role: "assistant",
      parts: [{ type: "text", text: "Hi there" }],
      index: 1,
      thinkingDurationMs: 1500,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a system event with session_result", () => {
    const result = NormalizedMessageSchema.safeParse({
      role: "system",
      event: { type: "session_result", totalCostUsd: 0.05, numTurns: 3 },
      index: 2,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a system event with system_init", () => {
    const result = NormalizedMessageSchema.safeParse({
      role: "system",
      event: {
        type: "system_init",
        slashCommands: [{ name: "/help", description: "Show help" }],
      },
      index: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts tool_use parts with summary", () => {
    const result = NormalizedMessageSchema.safeParse({
      role: "assistant",
      parts: [{
        type: "tool_use",
        toolUseId: "abc",
        toolName: "Bash",
        input: { command: "ls" },
        summary: { description: "List files", command: "ls" },
      }],
      index: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts tool_result parts", () => {
    const result = NormalizedMessageSchema.safeParse({
      role: "assistant",
      parts: [{
        type: "tool_result",
        toolUseId: "abc",
        output: "file1.ts\nfile2.ts",
        isError: false,
      }],
      index: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown role", () => {
    const result = NormalizedMessageSchema.safeParse({
      role: "admin",
      parts: [],
      index: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown part type within a message", () => {
    const result = NormalizedMessageSchema.safeParse({
      role: "user",
      parts: [{ type: "unknown_part", data: "stuff" }],
      index: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("isPathContained", () => {
  it("returns true for the root itself", () => {
    expect(isPathContained("/workspace", "/workspace")).toBe(true);
  });

  it("returns true for a child path", () => {
    expect(isPathContained("/workspace", "/workspace/project")).toBe(true);
  });

  it("returns false for a traversal attempt", () => {
    expect(isPathContained("/workspace", "/workspace/../etc/passwd")).toBe(false);
  });

  it("returns false for a sibling path", () => {
    expect(isPathContained("/workspace", "/tmp")).toBe(false);
  });

  it("returns false for a prefix trick (workspaceFoo)", () => {
    expect(isPathContained("/workspace", "/workspaceFoo")).toBe(false);
  });
});
