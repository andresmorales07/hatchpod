import { z } from "zod";
import "./common.js";
export declare const GitFileStatSchema: z.ZodObject<{
    path: z.ZodString;
    insertions: z.ZodNumber;
    deletions: z.ZodNumber;
    binary: z.ZodBoolean;
    untracked: z.ZodBoolean;
    staged: z.ZodBoolean;
}, z.core.$strip>;
export declare const GitDiffStatSchema: z.ZodObject<{
    files: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        insertions: z.ZodNumber;
        deletions: z.ZodNumber;
        binary: z.ZodBoolean;
        untracked: z.ZodBoolean;
        staged: z.ZodBoolean;
    }, z.core.$strip>>;
    totalInsertions: z.ZodNumber;
    totalDeletions: z.ZodNumber;
}, z.core.$strip>;
export type GitFileStat = z.infer<typeof GitFileStatSchema>;
export type GitDiffStat = z.infer<typeof GitDiffStatSchema>;
