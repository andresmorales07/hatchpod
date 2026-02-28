// Barrel export for all schemas and inferred types.
// Import common.ts first to ensure extendZodWithOpenApi runs before anything else.
export { UuidSchema, ErrorResponseSchema, isPathContained } from "./common.js";

export {
  TextPartSchema,
  ToolSummarySchema,
  ToolUsePartSchema,
  ToolResultPartSchema,
  ReasoningPartSchema,
  ErrorPartSchema,
  MessagePartSchema,
  SlashCommandSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  SystemEventSchema,
  NormalizedMessageSchema,
  TaskStatusSchema,
  ExtractedTaskSchema,
  PaginatedMessagesSchema,
  SessionListItemSchema,
  PermissionModeCommonSchema,
  SubagentStartedEventSchema,
  SubagentToolCallEventSchema,
  SubagentCompletedEventSchema,
} from "./providers.js";

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
  NormalizedMessage,
  TaskStatus,
  ExtractedTask,
  PaginatedMessages,
  SessionListItem,
  PermissionModeCommon,
  SubagentStartedEvent,
  SubagentToolCallEvent,
  SubagentCompletedEvent,
  ModeChangedEvent,
} from "./providers.js";

export {
  SessionStatusSchema,
  CreateSessionRequestSchema,
  SessionSummaryDTOSchema,
  SessionDetailResponseSchema,
  CreateSessionResponseSchema,
  DeleteSessionResponseSchema,
} from "./sessions.js";

export type {
  SessionStatus,
  CreateSessionRequest,
  SessionSummaryDTO,
} from "./sessions.js";

export { BrowseResponseSchema } from "./browse.js";
export { ConfigResponseSchema, ProviderInfoSchema } from "./config.js";
export { HealthResponseSchema } from "./health.js";

export { GitFileStatSchema, GitDiffStatSchema } from "./git.js";
export type { GitFileStat, GitDiffStat } from "./git.js";

export { SettingsSchema, PatchSettingsSchema } from "./settings.js";
export type { Settings } from "./settings.js";

export { openApiDocument } from "./registry.js";
