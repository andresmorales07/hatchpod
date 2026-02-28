import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SettingsSchema, PatchSettingsSchema } from "./schemas/settings.js";
import type { Settings } from "./schemas/settings.js";

const SETTINGS_DIR = join(
  process.env.HOME ?? "/home/hatchpod",
  ".config",
  "hatchpod",
);
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");
const SETTINGS_TMP_PATH = join(SETTINGS_DIR, "settings.json.tmp");

const DEFAULTS: Settings = {
  theme: "dark",
  terminalFontSize: 14,
  terminalScrollback: 1000,
  terminalShell: "/bin/bash",
};

export async function readSettings(): Promise<Settings> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed = SettingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    // File exists but is invalid — merge valid fields with defaults
    const partial = PatchSettingsSchema.safeParse(JSON.parse(raw));
    return { ...DEFAULTS, ...(partial.success ? partial.data : {}) };
  } catch (err) {
    // ENOENT or JSON parse error — return defaults
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Failed to read settings file, using defaults:", err);
    }
    return { ...DEFAULTS };
  }
}

export async function writeSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await readSettings();
  const updated = { ...current, ...partial };

  // Validate the merged result
  const result = SettingsSchema.safeParse(updated);
  if (!result.success) {
    throw new Error(`Invalid settings: ${result.error.issues[0]?.message ?? "validation failed"}`);
  }

  // Atomic write: write to temp file, then rename
  await mkdir(dirname(SETTINGS_TMP_PATH), { recursive: true });
  await writeFile(SETTINGS_TMP_PATH, JSON.stringify(result.data, null, 2));
  await rename(SETTINGS_TMP_PATH, SETTINGS_PATH);

  return result.data;
}
