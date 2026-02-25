import type { NormalizedMessage, ExtractedTask } from "./providers/types.js";
export type { ExtractedTask };
/**
 * Extract task state from an array of normalized messages.
 * Scans for TodoWrite tool_use parts — each call carries the full
 * todo list, so only the last one determines current state.
 */
export declare function extractTasks(messages: NormalizedMessage[]): ExtractedTask[];
