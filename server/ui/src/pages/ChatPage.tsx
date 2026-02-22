import { useEffect, useRef, useCallback, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { MessageBubble } from "@/components/MessageBubble";
import { ToolApproval } from "@/components/ToolApproval";
import { ThinkingIndicator } from "@/components/ThinkingIndicator";
import { Composer } from "@/components/Composer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowLeft, X } from "lucide-react";
import { cn } from "@/lib/utils";

const statusStyles: Record<string, string> = {
  idle: "bg-emerald-500/15 text-emerald-400 border-transparent",
  running: "bg-amber-500/15 text-amber-400 border-transparent",
  starting: "bg-amber-500/15 text-amber-400 border-transparent",
  error: "bg-red-400/15 text-red-400 border-transparent",
  disconnected: "bg-red-400/15 text-red-400 border-transparent",
  completed: "bg-muted-foreground/15 text-muted-foreground border-transparent",
  history: "bg-muted-foreground/10 text-muted-foreground italic border-transparent",
};

const SCROLL_THRESHOLD = 100;

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const {
    messages, slashCommands, status, connected, pendingApproval, lastError,
    thinkingText, thinkingStartTime, thinkingDurations,
    connect, disconnect, sendPrompt, approve, approveAlways, deny, interrupt,
  } = useMessagesStore();
  const activeSession = useSessionsStore((s) => s.sessions.find((sess) => sess.id === id));

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (id) {
      useSessionsStore.getState().setActiveSession(id);
      connect(id);
    }
    return () => disconnect();
  }, [id, connect, disconnect]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (isAtBottom) scrollToBottom();
  }, [messages, thinkingText, isAtBottom, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD);
  }, []);

  const isThinkingActive = thinkingText.length > 0 && thinkingStartTime != null;
  const isRunning = status === "running" || status === "starting";
  const sessionName = activeSession?.slug || activeSession?.summary || id?.slice(0, 8) || "Chat";
  const visibleError = lastError && lastError !== dismissedError ? lastError : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        {!isDesktop && (
          <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")}>
            <ArrowLeft className="size-5" />
          </Button>
        )}
        <span className="text-sm font-medium truncate flex-1">{sessionName}</span>
        <Badge variant="outline" className={cn("text-xs font-semibold uppercase tracking-wide", statusStyles[status])}>
          {status}
        </Badge>
        {!connected && (
          <Badge variant="outline" className={cn("text-xs font-semibold uppercase tracking-wide", statusStyles.disconnected)}>
            offline
          </Badge>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-hidden relative">
        <div ref={scrollContainerRef} onScroll={handleScroll} className="h-full overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-4 flex flex-col gap-4">
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} thinkingDurationMs={thinkingDurations[i] ?? null} />
            ))}
            {isThinkingActive && <ThinkingIndicator thinkingText={thinkingText} startTime={thinkingStartTime!} />}
            <div ref={messagesEndRef} />
          </div>
        </div>
        {!isAtBottom && (
          <Button
            variant="secondary"
            size="icon-sm"
            className="absolute bottom-4 right-4 rounded-full shadow-lg opacity-80 hover:opacity-100"
            onClick={() => { scrollToBottom(); setIsAtBottom(true); }}
          >
            <ArrowDown className="size-4" />
          </Button>
        )}
      </div>

      {/* Error banner */}
      {visibleError && (
        <div className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border-t border-destructive/30 text-destructive text-sm shrink-0">
          <span className="flex-1">{visibleError}</span>
          {status === "disconnected" && id && (
            <Button size="sm" variant="outline" onClick={() => { setDismissedError(visibleError); connect(id); }}>
              Reconnect
            </Button>
          )}
          <button onClick={() => setDismissedError(visibleError)} className="shrink-0 hover:opacity-70">
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* Tool approval */}
      {pendingApproval && (
        <ToolApproval
          toolName={pendingApproval.toolName}
          toolUseId={pendingApproval.toolUseId}
          input={pendingApproval.input}
          onApprove={approve}
          onApproveAlways={approveAlways}
          onDeny={deny}
        />
      )}

      {/* Composer */}
      <Composer
        slashCommands={slashCommands}
        isDisabled={isRunning}
        isRunning={isRunning}
        onSend={(text) => { const ok = sendPrompt(text); if (ok) setIsAtBottom(true); return ok; }}
        onInterrupt={interrupt}
      />
    </div>
  );
}
