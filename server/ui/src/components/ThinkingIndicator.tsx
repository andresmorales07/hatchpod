import { useState, useEffect } from "react";

/** Short CLI-style snippet — just a brief hint, not a full sentence. */
function extractSnippet(text: string): string {
  if (!text.trim()) return "Thinking";
  const lines = text.split("\n").filter((l) => l.trim());
  const last = (lines[lines.length - 1] || "").trim();
  if (!last) return "Thinking";
  // Truncate to a short descriptor, break at word boundary
  if (last.length <= 30) return last;
  const cut = last.slice(0, 30);
  const space = cut.lastIndexOf(" ");
  return (space > 10 ? cut.slice(0, space) : cut) + "\u2026";
}

interface Props {
  thinkingText: string;
  startTime: number;
}

export function ThinkingIndicator({ thinkingText, startTime }: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.round((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const snippet = extractSnippet(thinkingText);

  return (
    <div className="flex items-center gap-2 py-2 text-[0.8125rem] self-start">
      <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-primary animate-pulse" />
      <span className="text-primary italic overflow-hidden text-ellipsis whitespace-nowrap max-w-[500px]">{snippet}</span>
      <span className="text-muted-foreground text-xs whitespace-nowrap ml-auto">{elapsed}s</span>
    </div>
  );
}
