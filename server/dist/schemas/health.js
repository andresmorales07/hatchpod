import { z } from "zod";
import "./common.js"; // ensure extendZodWithOpenApi runs first
export const HealthResponseSchema = z
    .object({
    status: z.literal("ok"),
    uptime: z.number().int().openapi({ description: "Server uptime in seconds" }),
    sessions: z.object({
        active: z.number().int(),
        total: z.number().int(),
    }),
})
    .openapi("HealthResponse");
