import { z } from "zod";
import "./common.js";
export declare const HealthResponseSchema: z.ZodObject<{
    status: z.ZodLiteral<"ok">;
    uptime: z.ZodNumber;
    sessions: z.ZodObject<{
        active: z.ZodNumber;
        total: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
