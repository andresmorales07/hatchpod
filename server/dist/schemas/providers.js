import { z } from "zod";
import "./common.js"; // ensure extendZodWithOpenApi runs first
// ── Message parts ──
export const TextPartSchema = z
    .object({
    type: z.literal("text"),
    text: z.string(),
})
    .openapi("TextPart");
export const ToolSummarySchema = z
    .object({
    description: z.string().openapi({ description: "Human-readable one-liner shown as the primary label" }),
    command: z.string().optional().openapi({ description: "Raw command string (Bash only)" }),
})
    .openapi("ToolSummary");
export const ToolUsePartSchema = z
    .object({
    type: z.literal("tool_use"),
    toolUseId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    summary: ToolSummarySchema.optional().openapi({
        description: "Pre-computed summary for display. Populated server-side during normalization.",
    }),
})
    .openapi("ToolUsePart");
export const ToolResultPartSchema = z
    .object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    output: z.string(),
    isError: z.boolean(),
})
    .openapi("ToolResultPart");
export const ReasoningPartSchema = z
    .object({
    type: z.literal("reasoning"),
    text: z.string(),
})
    .openapi("ReasoningPart");
export const ErrorPartSchema = z
    .object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string().optional(),
})
    .openapi("ErrorPart");
export const MessagePartSchema = z
    .discriminatedUnion("type", [
    TextPartSchema,
    ToolUsePartSchema,
    ToolResultPartSchema,
    ReasoningPartSchema,
    ErrorPartSchema,
])
    .openapi("MessagePart");
// ── Slash commands ──
export const SlashCommandSchema = z
    .object({
    name: z.string(),
    description: z.string(),
    argumentHint: z.string().optional(),
})
    .openapi("SlashCommand");
// ── Normalized messages ──
export const UserMessageSchema = z
    .object({
    role: z.literal("user"),
    parts: z.array(MessagePartSchema),
    index: z.number().int(),
})
    .openapi("UserMessage");
export const AssistantMessageSchema = z
    .object({
    role: z.literal("assistant"),
    parts: z.array(MessagePartSchema),
    index: z.number().int(),
    thinkingDurationMs: z.number().optional(),
})
    .openapi("AssistantMessage");
const SessionResultEventSchema = z.object({
    type: z.literal("session_result"),
    totalCostUsd: z.number(),
    numTurns: z.number(),
});
const StatusEventSchema = z.object({
    type: z.literal("status"),
    status: z.string(),
});
const SystemInitEventSchema = z.object({
    type: z.literal("system_init"),
    slashCommands: z.array(SlashCommandSchema),
});
export const SystemEventSchema = z
    .object({
    role: z.literal("system"),
    event: z.discriminatedUnion("type", [
        SessionResultEventSchema,
        StatusEventSchema,
        SystemInitEventSchema,
    ]),
    index: z.number().int(),
})
    .openapi("SystemEvent");
export const NormalizedMessageSchema = z
    .discriminatedUnion("role", [
    UserMessageSchema,
    AssistantMessageSchema,
    SystemEventSchema,
])
    .openapi("NormalizedMessage");
// ── Task extraction ──
export const TaskStatusSchema = z
    .enum(["pending", "in_progress", "completed", "deleted"])
    .openapi("TaskStatus");
export const ExtractedTaskSchema = z
    .object({
    id: z.string(),
    subject: z.string(),
    activeForm: z.string().optional(),
    status: TaskStatusSchema,
})
    .openapi("ExtractedTask");
// ── Subagent events (ephemeral, not stored as messages) ──
export const SubagentStartedEventSchema = z
    .object({
    taskId: z.string().min(1),
    toolUseId: z.string().min(1),
    description: z.string().min(1),
    agentType: z.string().min(1).optional(),
})
    .openapi("SubagentStartedEvent");
export const SubagentToolCallEventSchema = z
    .object({
    toolUseId: z.string().min(1),
    toolName: z.string().min(1),
    summary: ToolSummarySchema,
})
    .openapi("SubagentToolCallEvent");
export const SubagentCompletedEventSchema = z
    .object({
    taskId: z.string().min(1),
    toolUseId: z.string().min(1),
    status: z.enum(["completed", "failed", "stopped"]),
    summary: z.string(),
})
    .openapi("SubagentCompletedEvent");
// ── Paginated messages ──
export const PaginatedMessagesSchema = z
    .object({
    messages: z.array(NormalizedMessageSchema),
    tasks: z.array(ExtractedTaskSchema),
    totalMessages: z.number().int(),
    hasMore: z.boolean(),
    oldestIndex: z.number().int(),
})
    .openapi("PaginatedMessages");
// ── Session listing ──
export const SessionListItemSchema = z
    .object({
    id: z.string(),
    slug: z.string().nullable(),
    summary: z.string().nullable(),
    cwd: z.string(),
    lastModified: z.string(),
    createdAt: z.string(),
})
    .openapi("SessionListItem");
// ── Permission mode ──
export const PermissionModeCommonSchema = z
    .enum(["default", "acceptEdits", "bypassPermissions", "plan", "delegate", "dontAsk"])
    .openapi("PermissionModeCommon");
