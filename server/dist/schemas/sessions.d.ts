import { z } from "zod";
import "./common.js";
export declare const SessionStatusSchema: z.ZodEnum<{
    error: "error";
    completed: "completed";
    idle: "idle";
    starting: "starting";
    running: "running";
    waiting_for_approval: "waiting_for_approval";
    interrupted: "interrupted";
    history: "history";
}>;
export declare const CreateSessionRequestSchema: z.ZodObject<{
    prompt: z.ZodOptional<z.ZodString>;
    permissionMode: z.ZodOptional<z.ZodEnum<{
        default: "default";
        acceptEdits: "acceptEdits";
        bypassPermissions: "bypassPermissions";
        plan: "plan";
        delegate: "delegate";
        dontAsk: "dontAsk";
    }>>;
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    allowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    resumeSessionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SessionSummaryDTOSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodEnum<{
        error: "error";
        completed: "completed";
        idle: "idle";
        starting: "starting";
        running: "running";
        waiting_for_approval: "waiting_for_approval";
        interrupted: "interrupted";
        history: "history";
    }>;
    createdAt: z.ZodString;
    lastModified: z.ZodString;
    numTurns: z.ZodNumber;
    totalCostUsd: z.ZodNumber;
    hasPendingApproval: z.ZodBoolean;
    provider: z.ZodString;
    slug: z.ZodNullable<z.ZodString>;
    summary: z.ZodNullable<z.ZodString>;
    cwd: z.ZodString;
}, z.core.$strip>;
export declare const SessionDetailResponseSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodEnum<{
        error: "error";
        completed: "completed";
        idle: "idle";
        starting: "starting";
        running: "running";
        waiting_for_approval: "waiting_for_approval";
        interrupted: "interrupted";
        history: "history";
    }>;
    cwd: z.ZodString;
    lastError: z.ZodNullable<z.ZodString>;
    pendingApproval: z.ZodNullable<z.ZodObject<{
        toolName: z.ZodString;
        toolUseId: z.ZodString;
        input: z.ZodUnknown;
    }, z.core.$strip>>;
    source: z.ZodLiteral<"api">;
}, z.core.$strip>;
export declare const CreateSessionResponseSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodEnum<{
        error: "error";
        completed: "completed";
        idle: "idle";
        starting: "starting";
        running: "running";
        waiting_for_approval: "waiting_for_approval";
        interrupted: "interrupted";
        history: "history";
    }>;
}, z.core.$strip>;
export declare const DeleteSessionResponseSchema: z.ZodObject<{
    status: z.ZodLiteral<"deleted">;
}, z.core.$strip>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type SessionSummaryDTO = z.infer<typeof SessionSummaryDTOSchema>;
