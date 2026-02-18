import type { NormalizedMessage, PermissionModeCommon, ApprovalDecision } from "./providers/types.js";
import type { WebSocket } from "ws";
export type SessionStatus = "idle" | "starting" | "running" | "waiting_for_approval" | "completed" | "interrupted" | "error";
export interface Session {
    id: string;
    provider: string;
    providerSessionId?: string;
    status: SessionStatus;
    createdAt: Date;
    permissionMode: PermissionModeCommon;
    model: string | undefined;
    cwd: string;
    abortController: AbortController;
    messages: NormalizedMessage[];
    totalCostUsd: number;
    numTurns: number;
    lastError: string | null;
    pendingApproval: PendingApproval | null;
    clients: Set<WebSocket>;
}
/** Serializable session representation for API responses (no internal handles). */
export interface SessionDTO {
    id: string;
    status: SessionStatus;
    createdAt: string;
    permissionMode: PermissionModeCommon;
    model: string | undefined;
    cwd: string;
    numTurns: number;
    totalCostUsd: number;
    lastError: string | null;
    messages: NormalizedMessage[];
    pendingApproval: {
        toolName: string;
        toolUseId: string;
        input: unknown;
    } | null;
}
/** Summary returned by GET /api/sessions (list endpoint). */
export interface SessionSummaryDTO {
    id: string;
    status: SessionStatus;
    createdAt: string;
    numTurns: number;
    totalCostUsd: number;
    hasPendingApproval: boolean;
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
}
