import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface Props {
  percentUsed: number;
}

export function ContextUsageBadge({ percentUsed }: Props) {
  const colorClass =
    percentUsed >= 90
      ? "bg-red-400/15 text-red-400 border-transparent"
      : percentUsed >= 75
        ? "bg-amber-500/15 text-amber-400 border-transparent"
        : "bg-muted-foreground/10 text-muted-foreground border-transparent";

  return (
    <Badge
      variant="outline"
      className={cn("text-xs font-semibold tabular-nums tracking-wide", colorClass)}
    >
      {percentUsed}% ctx
    </Badge>
  );
}
