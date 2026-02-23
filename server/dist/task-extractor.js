/**
 * Extract task state from an array of normalized messages.
 * Mirrors the client-side logic in ChatPage.tsx — scans tool_use/tool_result
 * parts for TaskCreate and TaskUpdate calls to build a task list.
 */
export function extractTasks(messages) {
    const taskMap = new Map();
    const pendingCreates = new Map();
    for (const msg of messages) {
        if (msg.role === "system")
            continue;
        for (const part of msg.parts) {
            if (part.type === "tool_use" && part.toolName === "TaskCreate") {
                const input = part.input;
                const subject = input && typeof input.subject === "string" ? input.subject : "Untitled task";
                const activeForm = input && typeof input.activeForm === "string" ? input.activeForm : undefined;
                const item = { id: part.toolUseId, subject, activeForm, status: "pending" };
                pendingCreates.set(part.toolUseId, item);
            }
            if (part.type === "tool_result") {
                const pending = pendingCreates.get(part.toolUseId);
                if (pending) {
                    const match = part.output.match(/Task #(\d+)/);
                    const taskId = match ? match[1] : part.toolUseId;
                    pending.id = taskId;
                    taskMap.set(taskId, pending);
                    pendingCreates.delete(part.toolUseId);
                }
            }
            if (part.type === "tool_use" && part.toolName === "TaskUpdate") {
                const input = part.input;
                if (!input)
                    continue;
                const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
                if (taskId && taskMap.has(taskId)) {
                    const existing = taskMap.get(taskId);
                    if (typeof input.status === "string")
                        existing.status = input.status;
                    if (typeof input.subject === "string")
                        existing.subject = input.subject;
                    if (typeof input.activeForm === "string")
                        existing.activeForm = input.activeForm;
                }
            }
        }
    }
    // Include creates that haven't gotten a result yet
    for (const item of pendingCreates.values()) {
        taskMap.set(item.id, item);
    }
    return Array.from(taskMap.values()).filter((t) => t.status !== "deleted");
}
