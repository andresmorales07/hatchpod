import type { ToolSummary } from "./types.js";
/** Extract a human-readable summary from tool input based on tool name. */
export declare function getToolSummary(toolName: string, input: unknown): ToolSummary;
