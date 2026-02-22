export interface TextPart {
    type: "text";
    text: string;
}
export interface ToolUsePart {
    type: "tool_use";
    toolUseId: string;
    toolName: string;
    input: unknown;
}
export interface ToolResultPart {
    type: "tool_result";
    toolUseId: string;
    output: string;
    isError: boolean;
}
export interface ReasoningPart {
    type: "reasoning";
    text: string;
}
export interface ErrorPart {
    type: "error";
    message: string;
    code?: string;
}
export type MessagePart = TextPart | ToolUsePart | ToolResultPart | ReasoningPart | ErrorPart;
export interface SlashCommand {
    name: string;
    description: string;
    argumentHint?: string;
}
export interface UserMessage {
    role: "user";
    parts: MessagePart[];
    index: number;
}
export interface AssistantMessage {
    role: "assistant";
    parts: MessagePart[];
    index: number;
    thinkingDurationMs?: number;
}
export interface SystemEvent {
    role: "system";
    event: {
        type: "session_result";
        totalCostUsd: number;
        numTurns: number;
    } | {
        type: "status";
        status: string;
    } | {
        type: "system_init";
        slashCommands: SlashCommand[];
    };
    index: number;
}
export type NormalizedMessage = UserMessage | AssistantMessage | SystemEvent;
export interface ToolApprovalRequest {
    toolName: string;
    toolUseId: string;
    input: unknown;
}
export type ApprovalDecision = {
    allow: true;
    updatedInput?: Record<string, unknown>;
    alwaysAllow?: boolean;
} | {
    allow: false;
    message?: string;
};
export type PermissionModeCommon = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "delegate" | "dontAsk";
export interface ProviderSessionOptions {
    prompt: string;
    cwd: string;
    permissionMode: PermissionModeCommon;
    model?: string;
    allowedTools?: string[];
    maxTurns?: number;
    abortSignal: AbortSignal;
    resumeSessionId?: string;
    onToolApproval: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
    onThinkingDelta?: (text: string) => void;
}
export interface ProviderSessionResult {
    providerSessionId?: string;
    totalCostUsd: number;
    numTurns: number;
}
export interface ProviderAdapter {
    readonly name: string;
    readonly id: string;
    run(options: ProviderSessionOptions): AsyncGenerator<NormalizedMessage, ProviderSessionResult, undefined>;
    getSessionHistory?(sessionId: string): Promise<NormalizedMessage[]>;
}
