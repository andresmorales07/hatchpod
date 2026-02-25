import type { GitDiffStat } from "./schemas/git.js";
/**
 * Compute a compact git diff stat for the given directory.
 * Returns null if the directory is not inside a git repo.
 *
 * Uses execFile (not exec) for all commands — prevents shell injection.
 */
export declare function computeGitDiffStat(cwd: string): Promise<GitDiffStat | null>;
