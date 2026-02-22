import { useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SessionSummary } from "@/stores/sessions";
import { useSessionsStore } from "@/stores/sessions";
import { useSwipe } from "@/hooks/useSwipe";
import { useIsDesktop } from "@/hooks/useMediaQuery";

interface Props {
  session: SessionSummary;
  isActive: boolean;
  onClick: () => void;
}

const statusDot: Record<string, string> = {
  idle: "bg-emerald-400",
  running: "bg-amber-400 animate-pulse",
  starting: "bg-amber-400 animate-pulse",
  error: "bg-red-400",
  completed: "bg-zinc-500",
  history: "border border-zinc-500 bg-transparent",
};

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sessionDisplayName(s: SessionSummary): string {
  if (s.summary) return s.summary;
  if (s.slug) return s.slug;
  return s.id.slice(0, 8);
}

export function SessionCard({ session, isActive, onClick }: Props) {
  const isDesktop = useIsDesktop();
  const [offsetX, setOffsetX] = useState(0);
  const [confirming, setConfirming] = useState(false);

  const swipe = useSwipe({
    threshold: 80,
    onSwipeLeft: () => { setOffsetX(0); setConfirming(true); },
    onProgress: (dx) => { if (dx < 0) setOffsetX(dx); },
    onCancel: () => setOffsetX(0),
  });

  const handleDelete = async () => {
    setConfirming(false);
    await useSessionsStore.getState().deleteSession(session.id);
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-destructive/10 border-l-2 border-l-destructive">
        <span className="flex-1 text-sm text-destructive">Delete this session?</span>
        <Button size="sm" variant="destructive" onClick={handleDelete} className="h-7 text-xs">Delete</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} className="h-7 text-xs">Cancel</Button>
      </div>
    );
  }

  const deleteHintOpacity = Math.min(Math.abs(offsetX) / 80, 1);

  const cardContent = (
    <button
      className={cn(
        "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
        "hover:bg-accent/50 active:bg-accent",
        isActive && "bg-accent border-l-2 border-l-primary"
      )}
      onClick={onClick}
    >
      <span className={cn("w-2 h-2 rounded-full shrink-0", statusDot[session.status] ?? "bg-zinc-500")} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{sessionDisplayName(session)}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {relativeTime(session.lastModified || session.createdAt)}
          {session.numTurns > 0 && ` · ${session.numTurns} turns`}
        </div>
        {session.cwd && (
          <p className="text-xs text-zinc-500 truncate mt-0.5">
            {session.cwd.replace(/^\/(?:home|Users)\/[^/]+/, "~")}
          </p>
        )}
      </div>
      {session.hasPendingApproval && (
        <Badge variant="destructive" className="text-[0.625rem] px-1.5 py-0 shrink-0">!</Badge>
      )}
    </button>
  );

  if (isDesktop) return cardContent;

  return (
    <div className="relative overflow-hidden">
      {/* Red delete hint revealed on swipe left */}
      <div
        className="absolute inset-0 bg-destructive/20 flex items-center justify-end pr-4"
        style={{ opacity: offsetX < -10 ? deleteHintOpacity : 0 }}
        aria-hidden
      >
        <span className="text-destructive text-sm font-semibold">Delete</span>
      </div>
      <div
        {...swipe}
        style={{ transform: `translateX(${offsetX}px)`, transition: offsetX === 0 ? "transform 0.2s ease" : "none" }}
        className="touch-pan-y"
      >
        {cardContent}
      </div>
    </div>
  );
}
