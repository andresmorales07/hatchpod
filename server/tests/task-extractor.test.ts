import { describe, it, expect } from "vitest";
import { extractTasks } from "../src/task-extractor.js";
import type { NormalizedMessage } from "../src/providers/types.js";

// ── Helpers ──

function makeTodoWrite(
  toolUseId: string,
  todos: Array<{ content: string; status: string; activeForm?: string }>,
): NormalizedMessage {
  return {
    role: "assistant",
    parts: [
      {
        type: "tool_use",
        toolUseId,
        toolName: "TodoWrite",
        input: { todos },
      },
    ],
    index: 0,
  };
}

// ── Tests ──

describe("extractTasks", () => {
  describe("TodoWrite basics", () => {
    it("extracts tasks from a TodoWrite call", () => {
      const msgs: NormalizedMessage[] = [
        makeTodoWrite("tu_1", [
          { content: "Implement auth", status: "pending" },
          { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
        ]),
      ];
      const tasks = extractTasks(msgs);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toMatchObject({ id: "1", subject: "Implement auth", status: "pending" });
      expect(tasks[1]).toMatchObject({ id: "2", subject: "Write tests", status: "in_progress", activeForm: "Writing tests" });
    });

    it("uses latest TodoWrite call (full replacement)", () => {
      const msgs: NormalizedMessage[] = [
        makeTodoWrite("tu_1", [
          { content: "Old task", status: "pending" },
        ]),
        makeTodoWrite("tu_2", [
          { content: "Old task", status: "completed" },
          { content: "New task", status: "in_progress", activeForm: "Working on new task" },
        ]),
      ];
      const tasks = extractTasks(msgs);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toMatchObject({ subject: "Old task", status: "completed" });
      expect(tasks[1]).toMatchObject({ subject: "New task", status: "in_progress" });
    });

    it("defaults subject to 'Untitled task' when content is missing", () => {
      const msgs: NormalizedMessage[] = [
        makeTodoWrite("tu_1", [
          { content: undefined as unknown as string, status: "pending" },
        ]),
      ];
      const tasks = extractTasks(msgs);
      expect(tasks[0].subject).toBe("Untitled task");
    });

    it("defaults status to 'pending' for invalid status", () => {
      const msgs: NormalizedMessage[] = [
        makeTodoWrite("tu_1", [
          { content: "Task", status: "bogus" },
        ]),
      ];
      const tasks = extractTasks(msgs);
      expect(tasks[0].status).toBe("pending");
    });

    it("handles TodoWrite with undefined input", () => {
      const msg: NormalizedMessage = {
        role: "assistant",
        parts: [
          {
            type: "tool_use",
            toolUseId: "tu_bad",
            toolName: "TodoWrite",
            input: undefined,
          },
        ],
        index: 0,
      };
      const tasks = extractTasks([msg]);
      expect(tasks).toHaveLength(0);
    });

    it("handles TodoWrite with non-array todos", () => {
      const msg: NormalizedMessage = {
        role: "assistant",
        parts: [
          {
            type: "tool_use",
            toolUseId: "tu_bad",
            toolName: "TodoWrite",
            input: { todos: "not an array" },
          },
        ],
        index: 0,
      };
      const tasks = extractTasks([msg]);
      expect(tasks).toHaveLength(0);
    });
  });

  describe("deletion filtering", () => {
    it("filters out tasks with status 'deleted'", () => {
      const msgs: NormalizedMessage[] = [
        makeTodoWrite("tu_1", [
          { content: "Keep me", status: "pending" },
          { content: "Delete me", status: "deleted" },
          { content: "Also keep", status: "in_progress" },
        ]),
      ];
      const tasks = extractTasks(msgs);
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.subject)).toEqual(["Keep me", "Also keep"]);
    });
  });

  describe("complex scenarios", () => {
    it("handles multiple TodoWrite calls across messages", () => {
      const msgs: NormalizedMessage[] = [
        makeTodoWrite("tu_1", [
          { content: "Task 1", status: "in_progress" },
          { content: "Task 2", status: "pending" },
        ]),
        makeTodoWrite("tu_2", [
          { content: "Task 1", status: "completed" },
          { content: "Task 2", status: "in_progress", activeForm: "Working on Task 2" },
          { content: "Task 3", status: "pending" },
        ]),
      ];
      const tasks = extractTasks(msgs);
      expect(tasks).toHaveLength(3);
      expect(tasks[0]).toMatchObject({ id: "1", status: "completed" });
      expect(tasks[1]).toMatchObject({ id: "2", status: "in_progress" });
      expect(tasks[2]).toMatchObject({ id: "3", status: "pending" });
    });

    it("skips system-role messages", () => {
      const msgs: NormalizedMessage[] = [
        {
          role: "system",
          event: { type: "session_result", totalCostUsd: 0, numTurns: 1 },
          index: 0,
        },
        makeTodoWrite("tu_1", [
          { content: "Real task", status: "pending" },
        ]),
      ];
      const tasks = extractTasks(msgs);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].subject).toBe("Real task");
    });

    it("preserves insertion order", () => {
      const msgs: NormalizedMessage[] = [
        makeTodoWrite("tu_1", [
          { content: "First", status: "pending" },
          { content: "Second", status: "pending" },
          { content: "Third", status: "pending" },
        ]),
      ];
      const tasks = extractTasks(msgs);
      expect(tasks.map((t) => t.subject)).toEqual(["First", "Second", "Third"]);
    });

    it("returns empty array for empty message list", () => {
      expect(extractTasks([])).toEqual([]);
    });

    it("returns empty array when no task-related tool calls exist", () => {
      const msgs: NormalizedMessage[] = [
        {
          role: "assistant",
          parts: [{ type: "text", text: "Just some text" }],
          index: 0,
        },
        {
          role: "user",
          parts: [{ type: "text", text: "A question" }],
          index: 1,
        },
      ];
      expect(extractTasks(msgs)).toEqual([]);
    });

    it("assigns 1-based IDs", () => {
      const msgs: NormalizedMessage[] = [
        makeTodoWrite("tu_1", [
          { content: "A", status: "pending" },
          { content: "B", status: "pending" },
        ]),
      ];
      const tasks = extractTasks(msgs);
      expect(tasks[0].id).toBe("1");
      expect(tasks[1].id).toBe("2");
    });
  });
});
