// ── Message parts (atomic renderable units) ──

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolSummary {
  /** Human-readable one-liner shown as the primary label. */
  description: string;
  /** Raw command string (Bash only) — rendered as a secondary monospace line. */
  command?: string;
}

export interface ToolUsePart {
  type: "tool_use";
  toolUseId: string;
  toolName: string;
  input: unknown;
  /** Pre-computed summary for display. Populated server-side during normalization. */
  summary?: ToolSummary;
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

export type MessagePart =
  | TextPart
  | ToolUsePart
  | ToolResultPart
  | ReasoningPart
  | ErrorPart;

// ── Slash commands ──

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

// ── Normalized messages (what clients render) ──

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
  event:
    | { type: "session_result"; totalCostUsd: number; numTurns: number }
    | { type: "status"; status: string }
    | { type: "system_init"; slashCommands: SlashCommand[] };
  index: number;
}

export type NormalizedMessage = UserMessage | AssistantMessage | SystemEvent;

// ── Task extraction ──

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface ExtractedTask {
  id: string;
  subject: string;
  activeForm?: string;
  status: TaskStatus;
}

// ── Paginated message response ──

export interface PaginatedMessages {
  messages: NormalizedMessage[];
  tasks: ExtractedTask[];
  totalMessages: number;
  hasMore: boolean;
  oldestIndex: number;
}

// ── Session listing ──

export interface SessionListItem {
  id: string;
  slug: string | null;
  summary: string | null;
  cwd: string;
  lastModified: string;
  createdAt: string;
}

// ── Tool approval (provider-agnostic) ──

export interface ToolApprovalRequest {
  toolName: string;
  toolUseId: string;
  input: unknown;
}

export type ApprovalDecision =
  | { allow: true; updatedInput?: Record<string, unknown>; alwaysAllow?: boolean }
  | { allow: false; message?: string };

// ── Permission mode (provider-agnostic) ──

export type PermissionModeCommon =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "delegate"
  | "dontAsk";

// ── Provider adapter interface ──

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
}
