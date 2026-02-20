import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface HistorySession {
  id: string;
  slug: string | null;
  summary: string | null;
  cwd: string;
  lastModified: Date;
  createdAt: Date;
}

interface CacheEntry {
  mtimeMs: number;
  session: HistorySession;
}

const cache = new Map<string, CacheEntry>();

/** Convert a CWD path to the Claude Code project directory path. */
export function cwdToProjectDir(cwd: string): string {
  const base = process.env.CLAUDE_PROJECTS_DIR
    ?? join(homedir(), ".claude", "projects");
  const mangled = cwd.replace(/\//g, "-");
  return join(base, mangled);
}

/** Clear the cache (for tests). */
export function clearHistoryCache(): void {
  cache.clear();
}

const MAX_LINES_TO_READ = 50;
const MAX_SUMMARY_LENGTH = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parse metadata from the first N lines of a JSONL session file. */
async function parseSessionMetadata(
  filePath: string,
  sessionId: string,
  mtimeMs: number,
): Promise<HistorySession> {
  let slug: string | null = null;
  let summary: string | null = null;
  let cwd = "";
  let firstTimestamp: string | null = null;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let lineCount = 0;
  for await (const line of rl) {
    if (lineCount++ >= MAX_LINES_TO_READ) break;
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract slug (first non-null occurrence)
    if (!slug && typeof parsed.slug === "string" && parsed.slug) {
      slug = parsed.slug;
    }

    // Extract cwd
    if (!cwd && typeof parsed.cwd === "string" && parsed.cwd) {
      cwd = parsed.cwd;
    }

    // Extract first timestamp
    if (!firstTimestamp && typeof parsed.timestamp === "string") {
      firstTimestamp = parsed.timestamp;
    }

    // Extract first user message as summary
    if (
      !summary &&
      parsed.type === "user" &&
      parsed.message &&
      typeof parsed.message === "object"
    ) {
      const msg = parsed.message as Record<string, unknown>;
      if (typeof msg.content === "string" && msg.content && !msg.content.startsWith("<")) {
        summary = msg.content.length > MAX_SUMMARY_LENGTH
          ? msg.content.slice(0, MAX_SUMMARY_LENGTH)
          : msg.content;
        // Collapse newlines for display
        summary = summary.replace(/\n+/g, " ").trim();
      }
    }

    // Early exit if we have everything
    if (slug && summary && cwd && firstTimestamp) break;
  }

  return {
    id: sessionId,
    slug,
    summary,
    cwd,
    lastModified: new Date(mtimeMs),
    createdAt: firstTimestamp ? new Date(firstTimestamp) : new Date(mtimeMs),
  };
}

/** List historical Claude Code sessions for a given CWD. */
export async function listSessionHistory(cwd: string): Promise<HistorySession[]> {
  const projectDir = cwdToProjectDir(cwd);

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter(
    (name) => name.endsWith(".jsonl") && UUID_RE.test(name.replace(".jsonl", "")),
  );

  const results: HistorySession[] = [];

  for (const fileName of jsonlFiles) {
    const filePath = join(projectDir, fileName);
    const sessionId = fileName.replace(".jsonl", "");

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }

    // Check cache
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === fileStat.mtimeMs) {
      results.push(cached.session);
      continue;
    }

    // Parse and cache
    try {
      const session = await parseSessionMetadata(filePath, sessionId, fileStat.mtimeMs);
      cache.set(filePath, { mtimeMs: fileStat.mtimeMs, session });
      results.push(session);
    } catch (err) {
      console.warn(`Failed to parse session history file ${filePath}:`, err);
    }
  }

  return results;
}
