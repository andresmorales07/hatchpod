import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
const cache = new Map();
/** Convert a CWD path to the Claude Code project directory path. */
export function cwdToProjectDir(cwd) {
    const base = process.env.CLAUDE_PROJECTS_DIR
        ?? join(homedir(), ".claude", "projects");
    const mangled = cwd.replace(/\//g, "-");
    return join(base, mangled);
}
/** Clear the cache (for tests). */
export function clearHistoryCache() {
    cache.clear();
}
const MAX_LINES_TO_READ = 50;
const MAX_SUMMARY_LENGTH = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Parse metadata from the first N lines of a JSONL session file. */
async function parseSessionMetadata(filePath, sessionId, mtimeMs) {
    let slug = null;
    let summary = null;
    let cwd = "";
    let firstTimestamp = null;
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({
        input: stream,
        crlfDelay: Infinity,
    });
    try {
        let lineCount = 0;
        for await (const line of rl) {
            if (lineCount++ >= MAX_LINES_TO_READ)
                break;
            if (!line.trim())
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
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
            if (!summary &&
                parsed.type === "user" &&
                parsed.message &&
                typeof parsed.message === "object") {
                const msg = parsed.message;
                if (typeof msg.content === "string" && msg.content && !msg.content.startsWith("<")) {
                    summary = msg.content.length > MAX_SUMMARY_LENGTH
                        ? msg.content.slice(0, MAX_SUMMARY_LENGTH)
                        : msg.content;
                    // Collapse newlines for display
                    summary = summary.replace(/\n+/g, " ").trim();
                }
            }
            // Early exit if we have everything
            if (slug && summary && cwd && firstTimestamp)
                break;
        }
    }
    finally {
        rl.close();
        stream.destroy();
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
/** Internal: scan a single project directory for JSONL session files. */
async function listSessionHistoryInDir(dirPath) {
    let entries;
    try {
        entries = await readdir(dirPath);
    }
    catch (err) {
        const code = err?.code;
        if (code !== "ENOENT") {
            console.warn(`Failed to read project directory ${dirPath}:`, err);
        }
        return [];
    }
    const jsonlFiles = entries.filter((name) => name.endsWith(".jsonl") && UUID_RE.test(name.replace(".jsonl", "")));
    const results = [];
    for (const fileName of jsonlFiles) {
        const filePath = join(dirPath, fileName);
        const sessionId = fileName.replace(".jsonl", "");
        let fileStat;
        try {
            fileStat = await stat(filePath);
        }
        catch (err) {
            const code = err?.code;
            if (code !== "ENOENT") {
                console.warn(`Failed to stat ${filePath}:`, err);
            }
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
        }
        catch (err) {
            console.warn(`Failed to parse session history file ${filePath}:`, err);
        }
    }
    return results;
}
/** List historical Claude Code sessions for a given CWD. */
export async function listSessionHistory(cwd) {
    return listSessionHistoryInDir(cwdToProjectDir(cwd));
}
/** List all historical sessions across every Claude Code project directory. */
export async function listAllSessionHistory() {
    const base = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
    let entries;
    try {
        entries = await readdir(base, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const results = await Promise.all(entries
        .filter((e) => e.isDirectory())
        .map((e) => listSessionHistoryInDir(join(base, e.name))));
    return results.flat();
}
