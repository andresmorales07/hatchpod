import { z } from "zod";

export const CommandHookSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  async: z.boolean().optional(),
  statusMessage: z.string().optional(),
});

export const HttpHookSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedEnvVars: z.array(z.string()).optional(),
  timeout: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
});

export const HookHandlerSchema = z.discriminatedUnion("type", [
  CommandHookSchema,
  HttpHookSchema,
]);

export const MatcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookHandlerSchema).min(1),
});

export const HOOK_EVENT_NAMES = [
  "SessionStart", "UserPromptSubmit", "PreToolUse",
  "PermissionRequest", "PostToolUse", "PostToolUseFailure",
  "Notification", "SubagentStart", "SubagentStop",
  "Stop", "TeammateIdle", "TaskCompleted", "ConfigChange",
  "WorktreeCreate", "WorktreeRemove", "PreCompact", "SessionEnd",
] as const;

export const HookEventNameSchema = z.enum(HOOK_EVENT_NAMES);

const validEventNames = new Set<string>(HOOK_EVENT_NAMES);

export const HookConfigSchema = z
  .record(z.string(), z.array(MatcherGroupSchema))
  .superRefine((obj, ctx) => {
    for (const key of Object.keys(obj)) {
      if (!validEventNames.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown hook event: ${key}`,
          path: [key],
        });
      }
    }
  });

export const WorkspaceInfoSchema = z.object({
  path: z.string(),
  sessionCount: z.number(),
});

export type CommandHook = z.infer<typeof CommandHookSchema>;
export type HttpHook = z.infer<typeof HttpHookSchema>;
export type HookHandler = z.infer<typeof HookHandlerSchema>;
export type MatcherGroup = z.infer<typeof MatcherGroupSchema>;
export type HookEventName = z.infer<typeof HookEventNameSchema>;
export type HookConfig = z.infer<typeof HookConfigSchema>;
export type WorkspaceInfo = z.infer<typeof WorkspaceInfoSchema>;
