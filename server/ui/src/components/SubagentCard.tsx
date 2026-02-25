import { useState, useEffect, useRef } from "react";
import type { ToolUsePart } from "@shared/types";
import { useMessagesStore } from "@/stores/messages";
import { cn } from "@/lib/utils";
import { Bot, ChevronDown, Check, X, Wrench } from "lucide-react";

interface Props {
  part: ToolUsePart;
}

function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Math.round((Date.now() - startedAt) / 1000));
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);
  return <span className="text-muted-foreground text-xs tabular-nums">{elapsed}s</span>;
}

export function SubagentCard({ part }: Props) {
  // Subscribe to the store for live updates — re-renders when this subagent's state changes
  const subagent = useMessagesStore((s) => s.activeSubagents.get(part.toolUseId));
  const input = part.input as Record<string, unknown> | undefined;
  const description = subagent?.description
    || (input?.description as string)
    || (input?.prompt as string)
    || "Running subagent...";
  const agentType = subagent?.agentType || (input?.subagent_type as string) || undefined;

  const isRunning = subagent?.status === "running";
  const isCompleted = subagent?.status === "completed";
  const isFailed = subagent?.status === "failed" || subagent?.status === "stopped";
  const hasLiveState = subagent != null;

  // Start expanded when running, collapsed for history replay.
  // User can toggle freely; status indicators in the header show
  // running/completed state clearly regardless of expanded state.
  const [expanded, setExpanded] = useState(isRunning);

  // Auto-scroll tool call list to latest while running
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isRunning && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [isRunning, subagent?.toolCalls.length]);

  const toolCalls = subagent?.toolCalls ?? [];
  const toolCallCount = toolCalls.length;

  // Status indicator for the header
  const statusIcon = isRunning ? (
    <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
  ) : isCompleted ? (
    <Check className="size-3.5 text-emerald-400 shrink-0" />
  ) : isFailed ? (
    <X className="size-3.5 text-destructive shrink-0" />
  ) : null;

  return (
    <div className={cn(
      "rounded-lg border overflow-hidden text-sm",
      isRunning
        ? "border-cyan-500/30 bg-cyan-950/10"
        : "border-border bg-card/50",
    )}>
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <Bot className={cn(
          "size-3.5 shrink-0",
          isRunning ? "text-cyan-400" : "text-muted-foreground",
        )} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {agentType && (
            <span className={cn(
              "text-xs font-medium shrink-0",
              isRunning ? "text-cyan-400" : "text-muted-foreground",
            )}>
              {agentType}
            </span>
          )}
          <span className="text-muted-foreground text-xs truncate">{description}</span>
        </div>
        {statusIcon}
        {isRunning && subagent && <ElapsedTime startedAt={subagent.startedAt} />}
        {hasLiveState && (
          <ChevronDown className={cn(
            "size-3.5 text-muted-foreground shrink-0 transition-transform",
            expanded && "rotate-180",
          )} />
        )}
      </button>

      {/* Expandable body — tool call list */}
      {expanded && toolCallCount > 0 && (
        <div
          ref={listRef}
          className="border-t border-border px-3 py-1.5 space-y-0.5 max-h-[200px] overflow-y-auto"
        >
          {toolCalls.map((tc, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
              <Wrench className="size-3 text-muted-foreground/60 shrink-0" />
              <span className="font-medium text-muted-foreground shrink-0">{tc.toolName}</span>
              {tc.summary.description && (
                <span className="text-muted-foreground/60 truncate">{tc.summary.description}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Footer — summary on completion */}
      {!isRunning && hasLiveState && (toolCallCount > 0 || subagent?.summary) && (
        <div className="border-t border-border px-3 py-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          {toolCallCount > 0 && (
            <span>{toolCallCount} tool call{toolCallCount !== 1 ? "s" : ""}</span>
          )}
          {subagent?.summary && (
            <>
              {toolCallCount > 0 && <span className="text-border">·</span>}
              <span className="truncate">{subagent.summary}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
