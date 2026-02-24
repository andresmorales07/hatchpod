import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { resolve } from "node:path";

// Must run before any .openapi() calls anywhere in the app
extendZodWithOpenApi(z);

export const UuidSchema = z
  .string()
  .uuid()
  .openapi({ description: "UUID identifier (case-insensitive per RFC 4122)", example: "550e8400-e29b-41d4-a716-446655440000" });

export const ErrorResponseSchema = z
  .object({
    error: z.string().openapi({ description: "Human-readable error message" }),
  })
  .openapi("ErrorResponse");

/**
 * Check whether `target` is contained within `root` (or is `root` itself).
 * Guards against path-traversal attacks (e.g. `../../etc/passwd`).
 */
export function isPathContained(root: string, target: string): boolean {
  const abs = resolve(root, target);
  return abs === root || abs.startsWith(root + "/");
}
