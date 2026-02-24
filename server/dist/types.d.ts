import type { NormalizedMessage, PermissionModeCommon, SlashCommand } from "./providers/types.js";
import type { ApprovalDecision } from "./providers/types.js";
export type { SessionStatus, CreateSessionRequest, SessionSummaryDTO } from "./schemas/sessions.js";
import type { SessionStatus } from "./schemas/sessions.js";
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
    /** The initial prompt text, stored so ws.ts can send it as a synthetic
     *  user message when a client connects before the JSONL file is available. */
    initialPrompt: string | null;
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
    totalMessages?: number;
    oldestIndex?: number;
} | {
    type: "tasks";
    tasks: Array<{
        id: string;
        subject: string;
        activeForm?: string;
        status: string;
    }>;
} | {
    type: "ping";
} | {
    type: "error";
    message: string;
};
