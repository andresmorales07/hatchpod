import { useEffect, useRef, useCallback, useState, useMemo, useLayoutEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { MessageBubble } from "@/components/MessageBubble";
import { ToolApproval } from "@/components/ToolApproval";
import { ThinkingIndicator } from "@/components/ThinkingIndicator";
import { Composer } from "@/components/Composer";
import { GitDiffBar } from "@/components/GitDiffBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextUsageBadge } from "@/components/ContextUsageBadge";
import { CompactingIndicator } from "@/components/CompactingIndicator";
import { ArrowDown, ArrowLeft, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { TaskList } from "@/components/TaskList";
import type { ToolResultPart, ExtractedTask, TaskStatus } from "@shared/types";

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
const SCROLL_UP_TRIGGER = 200;

const VALID_TASK_STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed", "deleted"]);

function isValidTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && VALID_TASK_STATUSES.has(value as TaskStatus);
}

export function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const {
    messages, slashCommands, status, source, connected, pendingApproval, lastError,
    thinkingText, thinkingStartTime,
    hasOlderMessages, loadingOlderMessages, loadOlderMessages, serverTasks,
    isCompacting, contextUsage, gitDiffStat,
    connect, disconnect, sendPrompt, approve, approveAlways, deny, interrupt,
  } = useMessagesStore();
  const activeSession = useSessionsStore((s) => s.sessions.find((sess) => sess.id === id));
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);

  useEffect(() => {
    if (activeSessionId && activeSessionId !== id) {
      navigate(`/session/${activeSessionId}`, { replace: true });
    }
  }, [activeSessionId, id, navigate]);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Track previous message count for scroll preservation on prepend
  const prevMessagesLenRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  // Flag to suppress auto-scroll after prepending older messages
  const justPrependedRef = useRef(false);

  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultPart>();
    for (const msg of messages) {
      if (msg.role === "user") {
        for (const part of msg.parts) {
          if (part.type === "tool_result") {
            map.set(part.toolUseId, part);
          }
        }
      }
    }
    return map;
  }, [messages]);

  // Extract tasks from live messages and merge with server tasks.
  // TodoWrite carries the full todo list on each call — only the last one matters.
  const tasks = useMemo(() => {
    // Start with server-provided tasks (from replay)
    let latestTodos: ExtractedTask[] = serverTasks.map((t) => ({ ...t }));

    // Scan live messages for TodoWrite calls — last one wins
    for (const msg of messages) {
      if (msg.role === "system") continue;
      for (const part of msg.parts) {
        if (part.type === "tool_use" && part.toolName === "TodoWrite") {
          const input = part.input as Record<string, unknown> | undefined;
          if (input && Array.isArray(input.todos)) {
            latestTodos = (input.todos as Array<Record<string, unknown>>).map((todo, i) => ({
              id: String(i + 1),
              subject: typeof todo.content === "string" ? todo.content : "Untitled task",
              activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined,
              status: isValidTaskStatus(todo.status) ? todo.status : "pending",
            }));
          }
        }
      }
    }
    return latestTodos.filter((t) => t.status !== "deleted");
  }, [messages, serverTasks]);

  useEffect(() => {
    if (!id) return;
    useSessionsStore.getState().setActiveSession(id);
    connect(id);
    return () => disconnect();
  }, [id, connect, disconnect]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    // Skip auto-scroll when older messages were just prepended — the
    // useLayoutEffect already restored scroll position.
    if (justPrependedRef.current) {
      justPrependedRef.current = false;
      return;
    }
    if (isAtBottom) scrollToBottom();
  }, [messages, thinkingText, isAtBottom, scrollToBottom]);

  // Restore scroll position after messages are prepended
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const prevLen = prevMessagesLenRef.current;
    const currentLen = messages.length;

    // Detect prepend: messages grew and user is scrolled up
    if (currentLen > prevLen && prevLen > 0 && !isAtBottom) {
      const heightDiff = el.scrollHeight - prevScrollHeightRef.current;
      if (heightDiff > 0) {
        el.scrollTop += heightDiff;
      }
      // Suppress the auto-scroll useEffect that would otherwise snap to bottom
      justPrependedRef.current = true;
    }

    prevMessagesLenRef.current = currentLen;
  }, [messages, isAtBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    setIsAtBottom(atBottom);

    // Scroll-up pagination trigger — capture scrollHeight before the load
    // so the layout effect can restore position after messages are prepended
    if (el.scrollTop < SCROLL_UP_TRIGGER && hasOlderMessages && !loadingOlderMessages) {
      prevScrollHeightRef.current = el.scrollHeight;
      loadOlderMessages();
    }
  }, [hasOlderMessages, loadingOlderMessages, loadOlderMessages]);

  const isRunning = status === "running" || status === "starting";
  // Show indicator for the entire "running" phase — not just when thinking text streams in.
  // Thinking text provides detail; the indicator itself shows "Thinking" as a baseline.
  const isThinkingActive = isRunning && !pendingApproval && thinkingStartTime != null;
  const isViewerMode = source === "cli" && !isRunning;
  const sessionName = activeSession?.summary || activeSession?.slug || id?.slice(0, 8) || "Chat";
  const visibleError = lastError && lastError !== dismissedError ? lastError : null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        {!isDesktop && (
          <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")}>
            <ArrowLeft className="size-5" />
          </Button>
        )}
        <span className="text-sm font-medium truncate flex-1">{sessionName}</span>
        {contextUsage && <ContextUsageBadge percentUsed={contextUsage.percentUsed} />}
        <Badge variant="outline" className={cn("text-xs font-semibold uppercase tracking-wide", statusStyles[status])}>
          {status}
        </Badge>
        {!connected && status !== "history" && (
          <Badge variant="outline" className={cn("text-xs font-semibold uppercase tracking-wide", statusStyles.disconnected)}>
            offline
          </Badge>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div ref={scrollContainerRef} onScroll={handleScroll} className="h-full overflow-y-auto [overflow-anchor:none]">
          <div className="max-w-3xl mx-auto px-4 py-4 flex flex-col gap-4">
            {/* Loading indicator for older messages */}
            {loadingOlderMessages && (
              <div className="flex justify-center py-2">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {messages.map((msg) => (
              <MessageBubble
                key={`${msg.role}-${msg.index}`}
                message={msg}
                toolResults={toolResults}
              />
            ))}
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

      {/* Compacting indicator — shown while conversation is being compacted */}
      {isCompacting && (
        <div className="max-w-3xl mx-auto px-4 w-full">
          <CompactingIndicator />
        </div>
      )}

      {/* Thinking indicator — fixed above composer, not in scroll */}
      {isThinkingActive && (
        <div className="max-w-3xl mx-auto px-4 w-full">
          <ThinkingIndicator thinkingText={thinkingText} startTime={thinkingStartTime!} />
        </div>
      )}

      {/* Task list */}
      {tasks.length > 0 && tasks.some((t) => t.status !== "completed") && (
        <div className="max-w-3xl mx-auto px-4 w-full">
          <TaskList tasks={tasks} />
        </div>
      )}

      {/* Composer */}
      <Composer
        slashCommands={slashCommands}
        isDisabled={isRunning}
        isRunning={isRunning}
        viewerMode={isViewerMode}
        onSend={(text) => { const ok = sendPrompt(text); if (ok) setIsAtBottom(true); return ok; }}
        onInterrupt={interrupt}
      />

      {/* Git diff status bar */}
      {gitDiffStat && gitDiffStat.files.length > 0 && (
        <GitDiffBar stat={gitDiffStat} />
      )}
    </div>
  );
}
