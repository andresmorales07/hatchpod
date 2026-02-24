import { z } from "zod";
import "./common.js";
export declare const BrowseResponseSchema: z.ZodObject<{
    path: z.ZodString;
    dirs: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
