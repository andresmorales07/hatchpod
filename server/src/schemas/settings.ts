import { z } from "zod";
import "./common.js"; // ensure extendZodWithOpenApi runs first

export const SettingsSchema = z
  .object({
    theme: z.enum(["dark", "light"]).openapi({ description: "UI color theme" }),
    terminalFontSize: z.number().int().min(10).max(20).openapi({ description: "Terminal font size in pixels (10–20)" }),
    terminalScrollback: z.number().int().min(100).max(10000).openapi({ description: "Terminal scrollback buffer size in lines (100–10000)" }),
    terminalShell: z.string().min(1).openapi({ description: "Default shell command for new terminal sessions" }),
  })
  .openapi("Settings");

export const PatchSettingsSchema = SettingsSchema.partial().openapi("PatchSettings");

export type Settings = z.infer<typeof SettingsSchema>;
