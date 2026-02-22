export interface HistorySession {
    id: string;
    slug: string | null;
    summary: string | null;
    cwd: string;
    lastModified: Date;
    createdAt: Date;
}
/** Convert a CWD path to the Claude Code project directory path. */
export declare function cwdToProjectDir(cwd: string): string;
/** Clear the cache (for tests). */
export declare function clearHistoryCache(): void;
/** List historical Claude Code sessions for a given CWD. */
export declare function listSessionHistory(cwd: string): Promise<HistorySession[]>;
/** List all historical sessions across every Claude Code project directory. */
export declare function listAllSessionHistory(): Promise<HistorySession[]>;
