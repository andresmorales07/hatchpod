import { z } from "zod";
import "./common.js";
export declare const ConfigResponseSchema: z.ZodObject<{
    browseRoot: z.ZodString;
    defaultCwd: z.ZodString;
}, z.core.$strip>;
export declare const ProviderInfoSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
}, z.core.$strip>;
