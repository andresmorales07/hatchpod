import type { NormalizedMessage, ExtractedTask, TaskStatus } from "./providers/types.js";

export type { ExtractedTask };

const VALID_STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed", "deleted"]);

function isValidStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && VALID_STATUSES.has(v as TaskStatus);
}

/**
 * Extract task state from an array of normalized messages.
 * Scans for TodoWrite tool_use parts — each call carries the full
 * todo list, so only the last one determines current state.
 */
export function extractTasks(messages: NormalizedMessage[]): ExtractedTask[] {
  let latestTodos: ExtractedTask[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;
    for (const part of msg.parts) {
      if (part.type === "tool_use" && part.toolName === "TodoWrite") {
        const input = part.input as Record<string, unknown> | undefined;
        if (input && Array.isArray(input.todos)) {
          latestTodos = (input.todos as Array<Record<string, unknown>>)
            .map((todo, i) => ({
              id: String(i + 1),
              subject: typeof todo.content === "string" ? todo.content : "Untitled task",
              activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined,
              status: isValidStatus(todo.status) ? todo.status : ("pending" as TaskStatus),
            }));
        }
      }
    }
  }

  return latestTodos.filter((t) => t.status !== "deleted");
}
