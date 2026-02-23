import type { NormalizedMessage } from "./providers/types.js";
export interface ExtractedTask {
    id: string;
    subject: string;
    activeForm?: string;
    status: string;
}
/**
 * Extract task state from an array of normalized messages.
 * Mirrors the client-side logic in ChatPage.tsx — scans tool_use/tool_result
 * parts for TaskCreate and TaskUpdate calls to build a task list.
 */
export declare function extractTasks(messages: NormalizedMessage[]): ExtractedTask[];
