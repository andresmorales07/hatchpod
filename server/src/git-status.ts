import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { GitDiffStat, GitFileStat } from "./schemas/git.js";

const execFile = promisify(execFileCb);

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB (default 1 MB too small for large repos)

export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "git",
      ["symbolic-ref", "--short", "HEAD"],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    );
    return stdout.trim() || null;
  } catch {
    // Detached HEAD or not a git repo
    return null;
  }
}

/**
 * Compute a compact git diff stat for the given directory.
 * Returns null if the directory is not inside a git repo.
 *
 * Uses execFile (not exec) for all commands — prevents shell injection.
 */
export async function computeGitDiffStat(
  cwd: string,
): Promise<GitDiffStat | null> {
  // Quick check: is this a git repo?
  try {
    await execFile("git", ["rev-parse", "--git-dir"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch {
    return null;
  }

  const files = new Map<string, GitFileStat>();
  let totalInsertions = 0;
  let totalDeletions = 0;

  // 1. Diff against HEAD (staged + unstaged combined)
  let diffOutput = "";
  try {
    const { stdout } = await execFile(
      "git",
      ["diff", "--numstat", "HEAD"],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    );
    diffOutput = stdout;
  } catch {
    // HEAD might not exist (empty repo). Try --cached only.
    try {
      const { stdout } = await execFile(
        "git",
        ["diff", "--cached", "--numstat"],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      );
      diffOutput = stdout;
    } catch {
      // No diff available
    }
  }

  for (const line of diffOutput.split("\n")) {
    if (!line.trim()) continue;
    const [ins, del, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;

    const binary = ins === "-" && del === "-";
    const insertions = binary ? 0 : parseInt(ins, 10) || 0;
    const deletions = binary ? 0 : parseInt(del, 10) || 0;
    totalInsertions += insertions;
    totalDeletions += deletions;

    files.set(path, {
      path,
      insertions,
      deletions,
      binary,
      untracked: false,
      staged: false,
    });
  }

  // 2. Mark staged files
  try {
    const { stdout } = await execFile(
      "git",
      ["diff", "--cached", "--name-only"],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    );
    for (const line of stdout.split("\n")) {
      const path = line.trim();
      if (!path) continue;
      const existing = files.get(path);
      if (existing) {
        existing.staged = true;
      }
    }
  } catch {
    // Non-critical
  }

  // 3. Untracked files
  try {
    const { stdout } = await execFile(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    );
    for (const line of stdout.split("\n")) {
      const path = line.trim();
      if (!path) continue;
      if (!files.has(path)) {
        files.set(path, {
          path,
          insertions: 0,
          deletions: 0,
          binary: false,
          untracked: true,
          staged: false,
        });
      }
    }
  } catch {
    // Non-critical
  }

  const branch = await getGitBranch(cwd);

  return {
    files: Array.from(files.values()),
    totalInsertions,
    totalDeletions,
    ...(branch !== null ? { branch } : {}),
  };
}
