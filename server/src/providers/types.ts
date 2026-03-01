// ── Serializable types — re-exported from Zod schemas (single source of truth) ──

export type {
  TextPart,
  ToolSummary,
  ToolUsePart,
  ToolResultPart,
  ReasoningPart,
  ErrorPart,
  MessagePart,
  SlashCommand,
  UserMessage,
  AssistantMessage,
  SystemEvent,
  ToolSummaryMessage,
  NormalizedMessage,
  TaskStatus,
  ExtractedTask,
  PaginatedMessages,
  SessionListItem,
  PermissionModeCommon,
  SubagentStartedEvent,
  SubagentToolCallEvent,
  SubagentCompletedEvent,
} from "../schemas/index.js";

// ── Provider interface types (contain callbacks, AbortSignal, AsyncGenerator) ──

import type {
  NormalizedMessage,
  PermissionModeCommon,
  PaginatedMessages,
  SessionListItem,
  SubagentStartedEvent,
  SubagentToolCallEvent,
  SubagentCompletedEvent,
} from "../schemas/index.js";

export interface ToolApprovalRequest {
  toolName: string;
  toolUseId: string;
  input: unknown;
}

export type ApprovalDecision =
  | { allow: true; updatedInput?: Record<string, unknown>; alwaysAllow?: boolean }
  | { allow: false; message?: string };

/** Opaque handle for controlling a live provider session. Defined here (not in the SDK) to keep SDK types isolated to claude-adapter.ts. */
export interface ProviderQueryHandle {
  streamInput(messages: AsyncIterable<unknown>): Promise<void>;
  close(): void;
  interrupt?(): void;
}

export interface ProviderSessionOptions {
  prompt: string;
  cwd: string;
  permissionMode: PermissionModeCommon;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  allowedTools?: string[];
  maxTurns?: number;
  abortSignal: AbortSignal;
  resumeSessionId?: string;
  onToolApproval: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
  onThinkingDelta?: (text: string) => void;
  onToolProgress?: (info: { toolUseId: string; toolName: string; elapsedSeconds: number }) => void;
  onSubagentStarted?: (info: SubagentStartedEvent) => void;
  onSubagentToolCall?: (info: SubagentToolCallEvent) => void;
  onSubagentCompleted?: (info: SubagentCompletedEvent) => void;
  onCompacting?: (isCompacting: boolean) => void;
  onContextUsage?: (usage: { inputTokens: number; contextWindow: number }) => void;
  onModeChanged?: (newMode: PermissionModeCommon) => void;
  onSessionIdResolved?: (sessionId: string) => void;
  /** Called immediately after the SDK query handle is created. Used to store a live reference for streaming input. */
  onQueryCreated?: (handle: ProviderQueryHandle) => void;
}

export interface ProviderSessionResult {
  providerSessionId?: string;
  totalCostUsd: number;
  numTurns: number;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly id: string;
  run(
    options: ProviderSessionOptions,
  ): AsyncGenerator<NormalizedMessage, ProviderSessionResult, undefined>;

  /** Load all normalized messages for a session from provider storage. */
  getSessionHistory(sessionId: string): Promise<NormalizedMessage[]>;

  /** Paginated message retrieval with task extraction. */
  getMessages(sessionId: string, options?: { before?: number; limit?: number }): Promise<PaginatedMessages>;

  /** List historical sessions, optionally filtered by CWD. */
  listSessions(cwd?: string): Promise<SessionListItem[]>;

  /** Resolve a session ID to its JSONL file path on disk. */
  getSessionFilePath(sessionId: string): Promise<string | null>;

  /** Parse a single raw JSONL line into a normalized message.
   *  Returns null for lines that don't produce a visible message.
   *  `index` is the caller-maintained message counter. */
  normalizeFileLine(line: string, index: number): NormalizedMessage | null;

  /** Maps tool names to the permission mode they transition to on approval. */
  readonly modeTransitionTools?: Map<string, PermissionModeCommon>;
}
