import type { NormalizedMessage, PermissionModeCommon, ApprovalDecision, SlashCommand } from "./providers/types.js";
export type SessionStatus = "idle" | "starting" | "running" | "waiting_for_approval" | "completed" | "interrupted" | "error" | "history";
/**
 * Runtime handle for API-driven sessions only.
 * No message storage — messages come from JSONL via SessionWatcher.
 * No client tracking — the watcher handles WebSocket subscriptions.
 */
export interface ActiveSession {
    sessionId: string;
    provider: string;
    cwd: string;
    createdAt: Date;
    permissionMode: PermissionModeCommon;
    model: string | undefined;
    abortController: AbortController;
    pendingApproval: PendingApproval | null;
    alwaysAllowedTools: Set<string>;
    status: SessionStatus;
    lastError: string | null;
}
/** Summary returned by GET /api/sessions (list endpoint). */
export interface SessionSummaryDTO {
    id: string;
    status: SessionStatus;
    createdAt: string;
    lastModified: string;
    numTurns: number;
    totalCostUsd: number;
    hasPendingApproval: boolean;
    provider: string;
    slug: string | null;
    summary: string | null;
    cwd: string;
}
export interface PendingApproval {
    toolName: string;
    toolUseId: string;
    input: unknown;
    resolve: (decision: ApprovalDecision) => void;
}
export type ClientMessage = {
    type: "prompt";
    text: string;
} | {
    type: "approve";
    toolUseId: string;
    alwaysAllow?: boolean;
    answers?: Record<string, string>;
} | {
    type: "deny";
    toolUseId: string;
    message?: string;
} | {
    type: "interrupt";
};
export type ServerMessage = {
    type: "message";
    message: NormalizedMessage;
} | {
    type: "tool_approval_request";
    toolName: string;
    toolUseId: string;
    input: unknown;
} | {
    type: "status";
    status: SessionStatus;
    error?: string;
    source?: "api" | "cli";
} | {
    type: "session_redirected";
    newSessionId: string;
} | {
    type: "slash_commands";
    commands: SlashCommand[];
} | {
    type: "thinking_delta";
    text: string;
} | {
    type: "replay_complete";
} | {
    type: "ping";
} | {
    type: "error";
    message: string;
};
export interface CreateSessionRequest {
    prompt?: string;
    permissionMode?: PermissionModeCommon;
    provider?: string;
    model?: string;
    cwd?: string;
    allowedTools?: string[];
    resumeSessionId?: string;
}
