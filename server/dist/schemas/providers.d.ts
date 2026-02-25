import { z } from "zod";
import "./common.js";
export declare const TextPartSchema: z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, z.core.$strip>;
export declare const ToolSummarySchema: z.ZodObject<{
    description: z.ZodString;
    command: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ToolUsePartSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    toolUseId: z.ZodString;
    toolName: z.ZodString;
    input: z.ZodUnknown;
    summary: z.ZodOptional<z.ZodObject<{
        description: z.ZodString;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ToolResultPartSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    toolUseId: z.ZodString;
    output: z.ZodString;
    isError: z.ZodBoolean;
}, z.core.$strip>;
export declare const ReasoningPartSchema: z.ZodObject<{
    type: z.ZodLiteral<"reasoning">;
    text: z.ZodString;
}, z.core.$strip>;
export declare const ErrorPartSchema: z.ZodObject<{
    type: z.ZodLiteral<"error">;
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const MessagePartSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    toolUseId: z.ZodString;
    toolName: z.ZodString;
    input: z.ZodUnknown;
    summary: z.ZodOptional<z.ZodObject<{
        description: z.ZodString;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    toolUseId: z.ZodString;
    output: z.ZodString;
    isError: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"reasoning">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"error">;
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "type">;
export declare const SlashCommandSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    argumentHint: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const UserMessageSchema: z.ZodObject<{
    role: z.ZodLiteral<"user">;
    parts: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        toolUseId: z.ZodString;
        toolName: z.ZodString;
        input: z.ZodUnknown;
        summary: z.ZodOptional<z.ZodObject<{
            description: z.ZodString;
            command: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        output: z.ZodString;
        isError: z.ZodBoolean;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"error">;
        message: z.ZodString;
        code: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], "type">>;
    index: z.ZodNumber;
}, z.core.$strip>;
export declare const AssistantMessageSchema: z.ZodObject<{
    role: z.ZodLiteral<"assistant">;
    parts: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        toolUseId: z.ZodString;
        toolName: z.ZodString;
        input: z.ZodUnknown;
        summary: z.ZodOptional<z.ZodObject<{
            description: z.ZodString;
            command: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        output: z.ZodString;
        isError: z.ZodBoolean;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"error">;
        message: z.ZodString;
        code: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], "type">>;
    index: z.ZodNumber;
    thinkingDurationMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const SystemEventSchema: z.ZodObject<{
    role: z.ZodLiteral<"system">;
    event: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"session_result">;
        totalCostUsd: z.ZodNumber;
        numTurns: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"status">;
        status: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"system_init">;
        slashCommands: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodString;
            argumentHint: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>], "type">;
    index: z.ZodNumber;
}, z.core.$strip>;
export declare const NormalizedMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    role: z.ZodLiteral<"user">;
    parts: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        toolUseId: z.ZodString;
        toolName: z.ZodString;
        input: z.ZodUnknown;
        summary: z.ZodOptional<z.ZodObject<{
            description: z.ZodString;
            command: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        output: z.ZodString;
        isError: z.ZodBoolean;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"error">;
        message: z.ZodString;
        code: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], "type">>;
    index: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    role: z.ZodLiteral<"assistant">;
    parts: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        toolUseId: z.ZodString;
        toolName: z.ZodString;
        input: z.ZodUnknown;
        summary: z.ZodOptional<z.ZodObject<{
            description: z.ZodString;
            command: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        output: z.ZodString;
        isError: z.ZodBoolean;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"reasoning">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"error">;
        message: z.ZodString;
        code: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], "type">>;
    index: z.ZodNumber;
    thinkingDurationMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    role: z.ZodLiteral<"system">;
    event: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"session_result">;
        totalCostUsd: z.ZodNumber;
        numTurns: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"status">;
        status: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"system_init">;
        slashCommands: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodString;
            argumentHint: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>], "type">;
    index: z.ZodNumber;
}, z.core.$strip>], "role">;
export declare const TaskStatusSchema: z.ZodEnum<{
    pending: "pending";
    in_progress: "in_progress";
    completed: "completed";
    deleted: "deleted";
}>;
export declare const ExtractedTaskSchema: z.ZodObject<{
    id: z.ZodString;
    subject: z.ZodString;
    activeForm: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        pending: "pending";
        in_progress: "in_progress";
        completed: "completed";
        deleted: "deleted";
    }>;
}, z.core.$strip>;
export declare const SubagentStartedEventSchema: z.ZodObject<{
    taskId: z.ZodString;
    toolUseId: z.ZodString;
    description: z.ZodString;
    agentType: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SubagentToolCallEventSchema: z.ZodObject<{
    toolUseId: z.ZodString;
    toolName: z.ZodString;
    summary: z.ZodObject<{
        description: z.ZodString;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const SubagentCompletedEventSchema: z.ZodObject<{
    taskId: z.ZodString;
    toolUseId: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
        stopped: "stopped";
    }>;
    summary: z.ZodString;
}, z.core.$strip>;
export declare const PaginatedMessagesSchema: z.ZodObject<{
    messages: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        role: z.ZodLiteral<"user">;
        parts: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_use">;
            toolUseId: z.ZodString;
            toolName: z.ZodString;
            input: z.ZodUnknown;
            summary: z.ZodOptional<z.ZodObject<{
                description: z.ZodString;
                command: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_result">;
            toolUseId: z.ZodString;
            output: z.ZodString;
            isError: z.ZodBoolean;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"reasoning">;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"error">;
            message: z.ZodString;
            code: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>], "type">>;
        index: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        role: z.ZodLiteral<"assistant">;
        parts: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_use">;
            toolUseId: z.ZodString;
            toolName: z.ZodString;
            input: z.ZodUnknown;
            summary: z.ZodOptional<z.ZodObject<{
                description: z.ZodString;
                command: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"tool_result">;
            toolUseId: z.ZodString;
            output: z.ZodString;
            isError: z.ZodBoolean;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"reasoning">;
            text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"error">;
            message: z.ZodString;
            code: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>], "type">>;
        index: z.ZodNumber;
        thinkingDurationMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>, z.ZodObject<{
        role: z.ZodLiteral<"system">;
        event: z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"session_result">;
            totalCostUsd: z.ZodNumber;
            numTurns: z.ZodNumber;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"status">;
            status: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"system_init">;
            slashCommands: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                description: z.ZodString;
                argumentHint: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
        }, z.core.$strip>], "type">;
        index: z.ZodNumber;
    }, z.core.$strip>], "role">>;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        subject: z.ZodString;
        activeForm: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<{
            pending: "pending";
            in_progress: "in_progress";
            completed: "completed";
            deleted: "deleted";
        }>;
    }, z.core.$strip>>;
    totalMessages: z.ZodNumber;
    hasMore: z.ZodBoolean;
    oldestIndex: z.ZodNumber;
}, z.core.$strip>;
export declare const SessionListItemSchema: z.ZodObject<{
    id: z.ZodString;
    slug: z.ZodNullable<z.ZodString>;
    summary: z.ZodNullable<z.ZodString>;
    cwd: z.ZodString;
    lastModified: z.ZodString;
    createdAt: z.ZodString;
}, z.core.$strip>;
export declare const PermissionModeCommonSchema: z.ZodEnum<{
    default: "default";
    acceptEdits: "acceptEdits";
    bypassPermissions: "bypassPermissions";
    plan: "plan";
    delegate: "delegate";
    dontAsk: "dontAsk";
}>;
export type TextPart = z.infer<typeof TextPartSchema>;
export type ToolSummary = z.infer<typeof ToolSummarySchema>;
export type ToolUsePart = z.infer<typeof ToolUsePartSchema>;
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>;
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>;
export type ErrorPart = z.infer<typeof ErrorPartSchema>;
export type MessagePart = z.infer<typeof MessagePartSchema>;
export type SlashCommand = z.infer<typeof SlashCommandSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type SystemEvent = z.infer<typeof SystemEventSchema>;
export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type ExtractedTask = z.infer<typeof ExtractedTaskSchema>;
export type PaginatedMessages = z.infer<typeof PaginatedMessagesSchema>;
export type SessionListItem = z.infer<typeof SessionListItemSchema>;
export type PermissionModeCommon = z.infer<typeof PermissionModeCommonSchema>;
export type SubagentStartedEvent = z.infer<typeof SubagentStartedEventSchema>;
export type SubagentToolCallEvent = z.infer<typeof SubagentToolCallEventSchema>;
export type SubagentCompletedEvent = z.infer<typeof SubagentCompletedEventSchema>;
