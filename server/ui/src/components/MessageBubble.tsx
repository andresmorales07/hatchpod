import { useState } from "react";
import type { NormalizedMessage, MessagePart } from "../types";
import { ThinkingBlock } from "./ThinkingBlock";
import { Markdown } from "./Markdown";
import { cn } from "@/lib/utils";
import { ChevronDown, Wrench, AlertCircle } from "lucide-react";

interface Props {
  message: NormalizedMessage;
  thinkingDurationMs: number | null;
}

function ToolCard({ part }: { part: { type: "tool_use"; toolName: string; input: unknown } | { type: "tool_result"; output: string } }) {
  const [expanded, setExpanded] = useState(false);
  const isUse = part.type === "tool_use";
  const label = isUse ? part.toolName : "Result";
  const content = isUse ? JSON.stringify(part.input, null, 2) : part.output;
  const preview = content.length > 120 ? content.slice(0, 117) + "..." : content;

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Wrench className="size-3.5 text-amber-400 shrink-0" />
        <span className="text-sm font-medium text-amber-400">{label}</span>
        <ChevronDown className={cn("size-3.5 text-muted-foreground ml-auto transition-transform", expanded && "rotate-180")} />
      </button>
      <div className="px-3 pb-2">
        <pre className="whitespace-pre-wrap font-mono text-xs leading-snug text-muted-foreground max-h-[300px] overflow-y-auto">
          {expanded ? content : preview}
        </pre>
      </div>
    </div>
  );
}

function renderPart(part: MessagePart, i: number, thinkingDurationMs: number | null) {
  switch (part.type) {
    case "text":
      return (
        <div key={i} className="text-sm leading-relaxed">
          <Markdown>{part.text}</Markdown>
        </div>
      );
    case "tool_use":
      return <ToolCard key={i} part={part} />;
    case "tool_result":
      return <ToolCard key={i} part={part} />;
    case "reasoning":
      return <ThinkingBlock key={i} text={part.text} durationMs={thinkingDurationMs} />;
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

export function MessageBubble({ message, thinkingDurationMs }: Props) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (!text) return null;
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
        {message.parts.map((part, i) => renderPart(part, i, thinkingDurationMs))}
      </div>
    );
  }

  if (message.role === "system" && message.event.type === "session_result") {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-muted-foreground bg-card/50 border border-border rounded-full px-4 py-1.5">
          Session completed · ${message.event.totalCostUsd.toFixed(4)} · {message.event.numTurns} turns
        </div>
      </div>
    );
  }

  return null;
}
