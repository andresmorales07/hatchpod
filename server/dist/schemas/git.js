import { z } from "zod";
import "./common.js"; // ensure extendZodWithOpenApi runs first
export const GitFileStatSchema = z
    .object({
    path: z.string().openapi({ description: "File path relative to repo root" }),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean().openapi({ description: "Binary file; insertions and deletions are always 0" }),
    untracked: z.boolean().openapi({ description: "New file not yet tracked by git" }),
    staged: z.boolean().openapi({ description: "File has staged changes" }),
})
    .openapi("GitFileStat");
export const GitDiffStatSchema = z
    .object({
    files: z.array(GitFileStatSchema),
    totalInsertions: z.number().int().nonnegative(),
    totalDeletions: z.number().int().nonnegative(),
})
    .openapi("GitDiffStat");
