// Message parts
export interface TextPart { type: "text"; text: string; }
export interface ToolUsePart { type: "tool_use"; toolUseId: string; toolName: string; input: unknown; }
export interface ToolResultPart { type: "tool_result"; toolUseId: string; output: string; isError: boolean; }
export interface ReasoningPart { type: "reasoning"; text: string; }
export interface ErrorPart { type: "error"; message: string; code?: string; }
export type MessagePart = TextPart | ToolUsePart | ToolResultPart | ReasoningPart | ErrorPart;

// Messages
export interface UserMessage { role: "user"; parts: MessagePart[]; index: number; }
export interface AssistantMessage { role: "assistant"; parts: MessagePart[]; index: number; }
export interface SystemEvent {
  role: "system";
  event:
    | { type: "session_result"; totalCostUsd: number; numTurns: number }
    | { type: "status"; status: string };
  index: number;
}
export type NormalizedMessage = UserMessage | AssistantMessage | SystemEvent;
