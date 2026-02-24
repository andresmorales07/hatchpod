import { z } from "zod";
import "./common.js"; // ensure extendZodWithOpenApi runs first
export const BrowseResponseSchema = z
    .object({
    path: z.string().openapi({ description: "Relative path that was browsed" }),
    dirs: z.array(z.string()).openapi({ description: "Subdirectory names (excludes hidden and node_modules)" }),
})
    .openapi("BrowseResponse");
