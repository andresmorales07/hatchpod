import type { NormalizedMessage, ExtractedTask } from "./providers/types.js";
export type { ExtractedTask };
/**
 * Extract task state from an array of normalized messages.
 * Mirrors the client-side logic in ChatPage.tsx — scans tool_use/tool_result
 * parts for TaskCreate and TaskUpdate calls to build a task list.
 */
export declare function extractTasks(messages: NormalizedMessage[]): ExtractedTask[];
