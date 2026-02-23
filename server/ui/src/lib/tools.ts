export interface ToolSummary {
  /** Human-readable one-liner shown as the primary label. */
  description: string;
  /** Raw command string (Bash only) — rendered as a secondary monospace line. */
  command?: string;
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

/** Extract a human-readable summary from tool input based on tool name. */
export function getToolSummary(toolName: string, input: unknown): ToolSummary {
  const empty: ToolSummary = { description: "" };
  if (input == null || typeof input !== "object") return empty;
  const obj = input as Record<string, unknown>;

  // ── Bash: prefer description field, show command as secondary ──
  if (toolName.includes("Bash") && typeof obj.command === "string") {
    const cmd = obj.command;
    const desc = typeof obj.description === "string" ? obj.description : truncate(cmd);
    return { description: desc, command: truncate(cmd, 120) };
  }

  // ── File tools: show the path ──
  const pathTools = ["Read", "Write", "Edit", "NotebookEdit"];
  if (pathTools.some((t) => toolName.includes(t)) && typeof obj.file_path === "string") {
    return { description: obj.file_path };
  }

  // ── Grep: "Search for <pattern>" + optional path ──
  if (toolName.includes("Grep") && typeof obj.pattern === "string") {
    let desc = `Search for "${truncate(obj.pattern, 50)}"`;
    if (typeof obj.path === "string") desc += ` in ${obj.path}`;
    return { description: desc };
  }

  // ── Glob: "Find files matching <pattern>" + optional path ──
  if (toolName.includes("Glob") && typeof obj.pattern === "string") {
    let desc = `Find files matching "${truncate(obj.pattern, 50)}"`;
    if (typeof obj.path === "string") desc += ` in ${obj.path}`;
    return { description: desc };
  }

  // ── WebFetch ──
  if (toolName.includes("WebFetch") && typeof obj.url === "string") {
    return { description: `Fetch ${truncate(obj.url, 70)}` };
  }

  // ── WebSearch ──
  if (toolName.includes("WebSearch") && typeof obj.query === "string") {
    return { description: `Search: "${truncate(obj.query, 60)}"` };
  }

  // ── Task (subagent) ──
  if (toolName.includes("Task") && typeof obj.description === "string") {
    return { description: obj.description };
  }

  // ── Fallback: first string value ──
  for (const val of Object.values(obj)) {
    if (typeof val === "string" && val.length > 0) {
      return { description: truncate(val) };
    }
  }
  return empty;
}
