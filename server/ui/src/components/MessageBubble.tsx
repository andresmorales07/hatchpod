import { useState } from "react";
import type { NormalizedMessage, MessagePart, TextPart, ToolResultPart } from "../types";

import { Markdown } from "./Markdown";
import { FileDiffCard } from "./FileDiffCard";
import { cn } from "@/lib/utils";
import { getToolSummary } from "@/lib/tools";
import { cleanMessageText } from "@/lib/message-cleanup";
import { ChevronDown, Wrench, AlertCircle, Bot } from "lucide-react";

interface Props {
  message: NormalizedMessage;
  toolResults: Map<string, ToolResultPart>;
}

function ToolCard({
  toolUse,
  toolResult,
}: {
  toolUse: { type: "tool_use"; toolUseId: string; toolName: string; input: unknown };
  toolResult?: ToolResultPart | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(toolUse.toolName, toolUse.input);
  const inputJson = JSON.stringify(toolUse.input, null, 2);
  const hasResult = toolResult != null && toolResult.output.length > 0;
  const isError = toolResult?.isError ?? false;

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden text-sm">
      {/* Header — always visible */}
      <button
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <Wrench className="size-3.5 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-amber-400 shrink-0">{toolUse.toolName}</span>
            {summary.description && (
              <span className="text-muted-foreground truncate text-xs">{summary.description}</span>
            )}
            {isError && <AlertCircle className="size-3.5 text-destructive shrink-0" />}
          </div>
          {summary.command && (
            <div className="text-muted-foreground/60 text-xs font-mono truncate mt-0.5">
              <span className="text-muted-foreground/40 mr-1">❯</span>{summary.command}
            </div>
          )}
        </div>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground shrink-0 mt-0.5 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {/* Expandable detail panel */}
      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {/* Input */}
          <div>
            <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Input
            </div>
            <pre className="whitespace-pre-wrap font-mono text-xs leading-snug text-muted-foreground bg-background/50 rounded p-2 max-h-[200px] overflow-y-auto">
              {inputJson}
            </pre>
          </div>

          {/* Output */}
          {hasResult && (
            <div>
              <div className={cn(
                "text-[0.6875rem] font-semibold uppercase tracking-wider mb-1",
                isError ? "text-destructive" : "text-muted-foreground",
              )}>
                {isError ? "Error" : "Output"}
              </div>
              <pre className={cn(
                "whitespace-pre-wrap font-mono text-xs leading-snug rounded p-2 max-h-[300px] overflow-y-auto",
                isError
                  ? "text-destructive bg-destructive/5 border border-destructive/20"
                  : "text-muted-foreground bg-background/50",
              )}>
                {toolResult!.output}
              </pre>
            </div>
          )}

          {!hasResult && toolResult == null && (
            <div className="text-xs text-muted-foreground italic">Waiting for result...</div>
          )}
        </div>
      )}
    </div>
  );
}

function renderPart(
  part: MessagePart,
  i: number,
  toolResults: Map<string, ToolResultPart>,
) {
  switch (part.type) {
    case "text": {
      const cleaned = cleanMessageText(part.text);
      if (!cleaned) return null;
      return (
        <div key={i} className="text-sm leading-relaxed">
          <Markdown>{cleaned}</Markdown>
        </div>
      );
    }
    case "tool_use": {
      // Task management tools are rendered by the persistent TaskList component
      if (["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(part.toolName)) {
        return null;
      }
      // Compact rendering for Task (subagent) tool calls
      if (part.toolName === "Task") {
        const input = part.input as Record<string, unknown> | undefined;
        const description = (input?.description as string) || (input?.prompt as string) || "Running subagent...";
        const agentType = input?.subagent_type as string | undefined;
        return (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-secondary/40 text-xs text-muted-foreground">
            <Bot className="size-3.5 shrink-0" />
            <span className="font-medium">Agent{agentType ? `: ${agentType}` : ""}</span>
            <span className="truncate">{description}</span>
          </div>
        );
      }
      // File diff rendering for Write/Edit
      if (part.toolName === "Write" || part.toolName === "Edit") {
        const result = toolResults.get(part.toolUseId) ?? null;
        return <FileDiffCard key={i} toolUse={part} toolResult={result} />;
      }

      const result = toolResults.get(part.toolUseId) ?? null;
      return <ToolCard key={i} toolUse={part} toolResult={result} />;
    }
    case "tool_result":
      // Rendered by the paired ToolCard above — skip standalone rendering
      return null;
    case "reasoning":
      return null;
    case "error":
      return (
        <div key={i} className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          {part.message}
        </div>
      );
    default:
      return null;
  }
}

export function MessageBubble({ message, toolResults }: Props) {
  // Hide user messages that only contain tool_result parts (shown inside ToolCard)
  if (message.role === "user") {
    const hasOnlyToolResults = message.parts.every((p) => p.type === "tool_result");
    if (hasOnlyToolResults) return null;
  }

  if (message.role === "user") {
    const text = cleanMessageText(
      message.parts
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join(""),
    );
    if (!text) return null;

    if (text.startsWith("/")) {
      return (
        <div className="flex justify-end">
          <div className="px-3 py-1.5 rounded-full bg-secondary/60 border border-border text-xs font-mono text-muted-foreground">
            {text}
          </div>
        </div>
      );
    }

    return (
      <div className="flex justify-end">
        <div className="px-4 py-2.5 rounded-2xl rounded-br-md bg-secondary text-sm max-w-[85%] md:max-w-[70%] break-words">
          {text}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="flex flex-col gap-2 max-w-[85%] md:max-w-[70%]">
        {message.parts.map((part, i) => renderPart(part, i, toolResults))}
      </div>
    );
  }

  return null;
}
