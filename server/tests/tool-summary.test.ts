import { describe, it, expect } from "vitest";
import { getToolSummary } from "../src/providers/tool-summary";

describe("getToolSummary", () => {
  describe("file path tools (Read, Write, Edit, NotebookEdit)", () => {
    it("returns file_path for Read", () => {
      expect(getToolSummary("Read", { file_path: "/src/index.ts" })).toEqual({
        description: "/src/index.ts",
      });
    });

    it("returns file_path for Write", () => {
      expect(getToolSummary("Write", { file_path: "/tmp/out.txt", content: "hello" })).toEqual({
        description: "/tmp/out.txt",
      });
    });

    it("returns file_path for Edit", () => {
      expect(getToolSummary("Edit", { file_path: "/src/app.ts", old_string: "a", new_string: "b" })).toEqual({
        description: "/src/app.ts",
      });
    });

    it("returns file_path for NotebookEdit", () => {
      expect(getToolSummary("NotebookEdit", { file_path: "/nb.ipynb", new_source: "x" })).toEqual({
        description: "/nb.ipynb",
      });
    });

    it("matches tool names containing the substring", () => {
      expect(getToolSummary("mcp__fs__Read", { file_path: "/foo" })).toEqual({
        description: "/foo",
      });
    });
  });

  describe("Bash", () => {
    it("returns description and command", () => {
      const result = getToolSummary("Bash", { command: "ls -la", description: "List files" });
      expect(result).toEqual({ description: "List files", command: "ls -la" });
    });

    it("falls back to command as description when no description field", () => {
      const result = getToolSummary("Bash", { command: "ls -la" });
      expect(result).toEqual({ description: "ls -la", command: "ls -la" });
    });

    it("truncates long commands in the command field at 120 chars", () => {
      const long = "x".repeat(150);
      const result = getToolSummary("Bash", { command: long });
      expect(result.command).toBe("x".repeat(117) + "...");
      expect(result.command!.length).toBe(120);
    });

    it("truncates command used as fallback description at 80 chars", () => {
      const long = "x".repeat(100);
      const result = getToolSummary("Bash", { command: long });
      expect(result.description).toBe("x".repeat(77) + "...");
      expect(result.description.length).toBe(80);
    });

    it("does not truncate short commands", () => {
      const result = getToolSummary("Bash", { command: "git status" });
      expect(result.command).toBe("git status");
    });
  });

  describe("Grep", () => {
    it("returns descriptive summary with pattern", () => {
      expect(getToolSummary("Grep", { pattern: "TODO|FIXME" })).toEqual({
        description: 'Search for "TODO|FIXME"',
      });
    });

    it("includes path when provided", () => {
      expect(getToolSummary("Grep", { pattern: "TODO", path: "server/" })).toEqual({
        description: 'Search for "TODO" in server/',
      });
    });
  });

  describe("Glob", () => {
    it("returns descriptive summary with pattern", () => {
      expect(getToolSummary("Glob", { pattern: "**/*.ts" })).toEqual({
        description: 'Find files matching "**/*.ts"',
      });
    });

    it("includes path when provided", () => {
      expect(getToolSummary("Glob", { pattern: "*.md", path: "docs/" })).toEqual({
        description: 'Find files matching "*.md" in docs/',
      });
    });
  });

  describe("WebFetch", () => {
    it("returns descriptive summary", () => {
      expect(getToolSummary("WebFetch", { url: "https://example.com" })).toEqual({
        description: "Fetch https://example.com",
      });
    });
  });

  describe("Task", () => {
    it("returns the description", () => {
      expect(getToolSummary("Task", { description: "Explore codebase" })).toEqual({
        description: "Explore codebase",
      });
    });
  });

  describe("WebSearch", () => {
    it("returns descriptive summary", () => {
      expect(getToolSummary("WebSearch", { query: "react hooks" })).toEqual({
        description: 'Search: "react hooks"',
      });
    });
  });

  describe("fallback behavior", () => {
    it("returns first string value for unknown tools", () => {
      expect(getToolSummary("CustomTool", { foo: 42, bar: "hello" })).toEqual({
        description: "hello",
      });
    });

    it("truncates long fallback values", () => {
      const long = "z".repeat(100);
      const result = getToolSummary("CustomTool", { val: long });
      expect(result.description).toBe("z".repeat(77) + "...");
    });

    it("skips empty string values in fallback", () => {
      expect(getToolSummary("CustomTool", { empty: "", real: "found" })).toEqual({
        description: "found",
      });
    });

    it("returns empty description when no string values exist", () => {
      expect(getToolSummary("CustomTool", { num: 42, flag: true })).toEqual({
        description: "",
      });
    });

    it("returns empty description for empty object", () => {
      expect(getToolSummary("CustomTool", {})).toEqual({ description: "" });
    });
  });

  describe("edge cases", () => {
    it("returns empty description for null input", () => {
      expect(getToolSummary("Read", null)).toEqual({ description: "" });
    });

    it("returns empty description for undefined input", () => {
      expect(getToolSummary("Read", undefined)).toEqual({ description: "" });
    });

    it("returns empty description for non-object input", () => {
      expect(getToolSummary("Read", "string")).toEqual({ description: "" });
      expect(getToolSummary("Read", 42)).toEqual({ description: "" });
    });
  });
});
