const VALID_STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
function isValidStatus(v) {
    return typeof v === "string" && VALID_STATUSES.has(v);
}
/**
 * Extract task state from an array of normalized messages.
 * Scans for TodoWrite tool_use parts — each call carries the full
 * todo list, so only the last one determines current state.
 */
export function extractTasks(messages) {
    let latestTodos = [];
    for (const msg of messages) {
        if (msg.role === "system")
            continue;
        for (const part of msg.parts) {
            if (part.type === "tool_use" && part.toolName === "TodoWrite") {
                const input = part.input;
                if (input && Array.isArray(input.todos)) {
                    latestTodos = input.todos
                        .map((todo, i) => ({
                        id: String(i + 1),
                        subject: typeof todo.content === "string" ? todo.content : "Untitled task",
                        activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined,
                        status: isValidStatus(todo.status) ? todo.status : "pending",
                    }));
                }
            }
        }
    }
    return latestTodos.filter((t) => t.status !== "deleted");
}
