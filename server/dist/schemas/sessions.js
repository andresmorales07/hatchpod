import { z } from "zod";
import "./common.js"; // ensure extendZodWithOpenApi runs first
import { PermissionModeCommonSchema } from "./providers.js";
// ── Session status ──
export const SessionStatusSchema = z
    .enum([
    "idle",
    "starting",
    "running",
    "waiting_for_approval",
    "completed",
    "interrupted",
    "error",
    "history",
])
    .openapi("SessionStatus");
// ── Create session request ──
export const CreateSessionRequestSchema = z
    .object({
    prompt: z
        .string({ message: "prompt must be a string" })
        .optional(),
    permissionMode: z
        .enum(PermissionModeCommonSchema.options, { message: "invalid permissionMode" })
        .optional()
        .openapi({ description: "Permission mode for the session" }),
    provider: z.string().optional().openapi({ description: "Provider ID (defaults to 'claude')" }),
    model: z.string().optional().openapi({ description: "Model override" }),
    cwd: z
        .string({ message: "invalid cwd" })
        .refine((v) => !v.includes("\0"), { message: "invalid cwd" })
        .optional()
        .openapi({ description: "Working directory (must be within BROWSE_ROOT)" }),
    allowedTools: z.array(z.string()).optional().openapi({ description: "Pre-allowed tool names" }),
    resumeSessionId: z
        .string()
        .uuid({ message: "resumeSessionId must be a valid UUID" })
        .optional()
        .openapi({ description: "Session ID to resume" }),
})
    .openapi("CreateSessionRequest");
// ── Session summary (list endpoint DTO) ──
export const SessionSummaryDTOSchema = z
    .object({
    id: z.string(),
    status: SessionStatusSchema,
    createdAt: z.string(),
    lastModified: z.string(),
    numTurns: z.number().int(),
    totalCostUsd: z.number(),
    hasPendingApproval: z.boolean(),
    provider: z.string(),
    slug: z.string().nullable(),
    summary: z.string().nullable(),
    cwd: z.string(),
})
    .openapi("SessionSummaryDTO");
// ── Session detail response ──
export const SessionDetailResponseSchema = z
    .object({
    id: z.string(),
    status: SessionStatusSchema,
    cwd: z.string(),
    lastError: z.string().nullable(),
    pendingApproval: z
        .object({
        toolName: z.string(),
        toolUseId: z.string(),
        input: z.unknown(),
    })
        .nullable(),
    source: z.literal("api"),
})
    .openapi("SessionDetailResponse");
// ── Create / Delete responses ──
export const CreateSessionResponseSchema = z
    .object({
    id: z.string(),
    status: SessionStatusSchema,
})
    .openapi("CreateSessionResponse");
export const DeleteSessionResponseSchema = z
    .object({
    status: z.literal("deleted"),
})
    .openapi("DeleteSessionResponse");
