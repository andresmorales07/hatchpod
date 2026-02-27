import { useState } from "react";
import type React from "react";
import type { NormalizedMessage, MessagePart, TextPart, ToolResultPart, ToolUsePart } from "@shared/types";

import { Markdown } from "./Markdown";
import { FileDiffCard } from "./FileDiffCard";
import { SubagentCard } from "./SubagentCard";
import { cn } from "@/lib/utils";
import { ChevronDown, Wrench, AlertCircle } from "lucide-react";

interface Props {
  message: NormalizedMessage;
  toolResults: Map<string, ToolResultPart>;
}

// Tools rendered by special-purpose components — excluded from generic grouping.
// Exported so ChatPage can use it when pre-grouping cross-message tool batches.
export function isGenericToolUse(part: ToolUsePart): boolean {
  if (["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(part.toolName)) return false;
  if (part.toolName === "Task") return false;
  if (part.toolName === "Write" || part.toolName === "Edit") return false;
  return true;
}

// Shared expandable detail panel (used by both ToolCard and ToolRow)
function ToolDetail({
  toolUse,
  toolResult,
}: {
  toolUse: ToolUsePart;
  toolResult?: ToolResultPart | null;
}) {
  const inputJson = JSON.stringify(toolUse.input, null, 2);
  const hasResult = toolResult != null && toolResult.output.length > 0;
  const isError = toolResult?.isError ?? false;

  return (
    <div className="px-3 py-2 space-y-2">
      <div>
        <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          Input
        </div>
        <pre className="whitespace-pre-wrap font-mono text-xs leading-snug text-muted-foreground bg-background/50 rounded p-2 max-h-[200px] overflow-y-auto">
          {inputJson}
        </pre>
      </div>
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
  );
}

// Standalone card for a single generic tool call
function ToolCard({
  toolUse,
  toolResult,
}: {
  toolUse: ToolUsePart;
  toolResult?: ToolResultPart | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolUse.summary ?? { description: "" };
  const isError = toolResult?.isError ?? false;

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden text-sm">
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
      {expanded && (
        <div className="border-t border-border">
          <ToolDetail toolUse={toolUse} toolResult={toolResult} />
        </div>
      )}
    </div>
  );
}

// A single expandable row inside a ToolGroupCard
function ToolRow({
  toolUse,
  toolResult,
}: {
  toolUse: ToolUsePart;
  toolResult?: ToolResultPart | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolUse.summary ?? { description: "" };
  const isError = toolResult?.isError ?? false;

  return (
    <div>
      <button
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-amber-400 shrink-0 text-sm">{toolUse.toolName}</span>
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
      {expanded && (
        <div className="border-t border-border bg-background/20">
          <ToolDetail toolUse={toolUse} toolResult={toolResult} />
        </div>
      )}
    </div>
  );
}

// Groups 2+ consecutive generic tool calls into a single collapsible card.
// Exported so ChatPage can render cross-message tool batches directly.
export function ToolGroupCard({
  toolUses,
  toolResults,
}: {
  toolUses: ToolUsePart[];
  toolResults: Map<string, ToolResultPart>;
}) {
  const [expanded, setExpanded] = useState(true);
  const count = toolUses.length;

  // Collect up to 3 unique tool names for the header label
  const seen = new Set<string>();
  const uniqueNames: string[] = [];
  for (const t of toolUses) {
    if (!seen.has(t.toolName)) {
      seen.add(t.toolName);
      uniqueNames.push(t.toolName);
    }
  }
  const headerNames =
    uniqueNames.slice(0, 3).join(" · ") + (uniqueNames.length > 3 ? " ···" : "");
  const hasError = toolUses.some((t) => toolResults.get(t.toolUseId)?.isError);

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden text-sm">
      {/* Group header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <Wrench className="size-3.5 text-amber-400 shrink-0" />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-medium text-amber-400 truncate">{headerNames}</span>
          <span className="text-muted-foreground text-xs shrink-0">× {count}</span>
          {hasError && <AlertCircle className="size-3.5 text-destructive shrink-0" />}
        </div>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground shrink-0 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {/* Individual rows */}
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {toolUses.map((toolUse) => (
            <ToolRow
              key={toolUse.toolUseId}
              toolUse={toolUse}
              toolResult={toolResults.get(toolUse.toolUseId) ?? null}
            />
          ))}
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
      if (!part.text) return null;
      return (
        <div key={i} className="text-sm leading-relaxed">
          <Markdown>{part.text}</Markdown>
        </div>
      );
    }
    case "tool_use": {
      // Task management tools are rendered by the persistent TaskList component
      if (["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(part.toolName)) {
        return null;
      }
      // Live subagent card — shows tool calls in real time, falls back to static indicator
      if (part.toolName === "Task") {
        return <SubagentCard key={i} part={part} />;
      }
      // File diff rendering for Write/Edit
      if (part.toolName === "Write" || part.toolName === "Edit") {
        const result = toolResults.get(part.toolUseId) ?? null;
        return <FileDiffCard key={i} toolUse={part} toolResult={result} />;
      }
      // Generic tool — handled by renderParts grouping, but fallback for direct calls
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

// Render assistant message parts, merging consecutive generic tool calls into ToolGroupCard
function renderParts(parts: MessagePart[], toolResults: Map<string, ToolResultPart>) {
  const nodes: (React.ReactNode)[] = [];
  let i = 0;

  while (i < parts.length) {
    const part = parts[i];

    if (part.type === "tool_use" && isGenericToolUse(part)) {
      // Collect the full run of consecutive generic tool_use parts
      const group: ToolUsePart[] = [];
      while (
        i < parts.length &&
        parts[i].type === "tool_use" &&
        isGenericToolUse(parts[i] as ToolUsePart)
      ) {
        group.push(parts[i] as ToolUsePart);
        i++;
      }
      if (group.length === 1) {
        const result = toolResults.get(group[0].toolUseId) ?? null;
        nodes.push(<ToolCard key={group[0].toolUseId} toolUse={group[0]} toolResult={result} />);
      } else {
        nodes.push(
          <ToolGroupCard key={group[0].toolUseId} toolUses={group} toolResults={toolResults} />,
        );
      }
    } else {
      nodes.push(renderPart(part, i, toolResults));
      i++;
    }
  }

  return nodes;
}

export function MessageBubble({ message, toolResults }: Props) {
  // Render system events inline
  if (message.role === "system") {
    if ("event" in message && message.event.type === "compact_boundary") {
      const { trigger, preTokens } = message.event;
      const label = trigger === "manual" ? "Conversation compacted" : "Auto-compacted";
      const tokenStr = preTokens > 0
        ? ` (was ${preTokens >= 1000 ? `${Math.round(preTokens / 1000)}k` : preTokens} tokens)`
        : "";
      return (
        <div className="flex items-center gap-3 py-2">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {label}{tokenStr}
          </span>
          <div className="flex-1 h-px bg-border" />
        </div>
      );
    }
    return null;
  }

  if (message.role === "user") {
    // Hide user messages that only contain tool_result parts (shown inside ToolCard)
    const hasOnlyToolResults = message.parts.every((p) => p.type === "tool_result");
    if (hasOnlyToolResults) return null;

    const text = message.parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("");
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
        {renderParts(message.parts, toolResults)}
      </div>
    );
  }

  return null;
}
