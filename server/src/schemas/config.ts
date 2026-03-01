import { z } from "zod";
import "./common.js"; // ensure extendZodWithOpenApi runs first

export const ConfigResponseSchema = z
  .object({
    browseRoot: z.string().openapi({ description: "Absolute path to the file browser root" }),
    defaultCwd: z.string().openapi({ description: "Default working directory for new sessions" }),
    version: z.string().openapi({ description: "Server version (SemVer)" }),
    supportedModels: z
      .array(z.object({ id: z.string(), name: z.string().optional(), description: z.string().optional() }))
      .nullable()
      .openapi({ description: "Available models probed at startup, or null if not yet loaded" }),
  })
  .openapi("ConfigResponse");

export const ProviderInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .openapi("ProviderInfo");
