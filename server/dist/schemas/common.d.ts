import { z } from "zod";
export declare const UuidSchema: z.ZodString;
export declare const ErrorResponseSchema: z.ZodObject<{
    error: z.ZodString;
}, z.core.$strip>;
/**
 * Check whether `target` is contained within `root` (or is `root` itself).
 * Guards against path-traversal attacks (e.g. `../../etc/passwd`).
 */
export declare function isPathContained(root: string, target: string): boolean;
