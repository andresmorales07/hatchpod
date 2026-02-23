// Message parts
export interface TextPart { type: "text"; text: string; }
export interface ToolUsePart { type: "tool_use"; toolUseId: string; toolName: string; input: unknown; }
export interface ToolResultPart { type: "tool_result"; toolUseId: string; output: string; isError: boolean; }
export interface ReasoningPart { type: "reasoning"; text: string; }
export interface ErrorPart { type: "error"; message: string; code?: string; }
export type MessagePart = TextPart | ToolUsePart | ToolResultPart | ReasoningPart | ErrorPart;

// Messages
export interface UserMessage { role: "user"; parts: MessagePart[]; index: number; }
export interface AssistantMessage { role: "assistant"; parts: MessagePart[]; index: number; thinkingDurationMs?: number; }
export interface SystemEvent {
  role: "system";
  event:
    | { type: "status"; status: string }
    | { type: "system_init"; slashCommands: SlashCommand[] };
  index: number;
}
export type NormalizedMessage = UserMessage | AssistantMessage | SystemEvent;

// Task items (extracted from tool_use messages in the chat)
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TaskItem {
  id: string;
  subject: string;
  activeForm?: string;
  status: TaskStatus;
}

// Slash commands
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}
