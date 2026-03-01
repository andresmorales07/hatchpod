import { useEffect, useRef, useCallback, useState, useMemo, useLayoutEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMessagesStore } from "@/stores/messages";
import { useSessionsStore } from "@/stores/sessions";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { MessageBubble, ToolGroupCard, isGenericToolUse } from "@/components/MessageBubble";
import { ToolApproval, PlanTransitionCard } from "@/components/ToolApproval";
import { ThinkingIndicator } from "@/components/ThinkingIndicator";
import { Composer } from "@/components/Composer";
import { GitDiffBar } from "@/components/GitDiffBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextUsageBadge } from "@/components/ContextUsageBadge";
import { CompactingIndicator } from "@/components/CompactingIndicator";
import { ArrowDown, ArrowLeft, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PERMISSION_MODES } from "@/lib/sessions";
import { TaskList } from "@/components/TaskList";
import { ModelPicker, modelLabel } from "@/components/ModelPicker";
import { SessionInfoSheet } from "@/components/SessionInfoSheet";
import type { NormalizedMessage, ToolResultPart, ToolUsePart, ExtractedTask, TaskStatus } from "@shared/types";

const statusStyles: Record<string, string> = {
  idle: "bg-emerald-500/15 text-emerald-400 border-transparent",
  running: "bg-amber-500/15 text-amber-400 border-transparent",
  starting: "bg-amber-500/15 text-amber-400 border-transparent",
  error: "bg-red-400/15 text-red-400 border-transparent",
  disconnected: "bg-red-400/15 text-red-400 border-transparent",
  completed: "bg-muted-foreground/15 text-muted-foreground border-transparent",
  history: "bg-muted-foreground/10 text-muted-foreground italic border-transparent",
};

const modeStyles: Record<string, string> = {
  plan: "bg-blue-500/15 text-blue-400 border-transparent",
  acceptEdits: "bg-amber-500/15 text-amber-400 border-transparent",
  bypassPermissions: "bg-red-500/15 text-red-400 border-transparent",
  default: "bg-muted-foreground/15 text-muted-foreground border-transparent",
};

const modeLabels: Record<string, string> = {
  plan: "Plan",
  acceptEdits: "Accept Edits",
  bypassPermissions: "Auto",
  default: "Default",
};

const SCROLL_THRESHOLD = 100;

// Narrow the NormalizedMessage union to just the assistant variant (which has `parts`).
type AssistantMessage = Extract<NormalizedMessage, { role: "assistant" }>;

// Type predicate — qualifies an assistant message for cross-message batching:
// no meaningful text, and every tool_use part is a generic tool (not Write/Edit/Task/…).
function isToolOnlyAssistantMessage(msg: NormalizedMessage): msg is AssistantMessage {
  if (msg.role !== "assistant") return false;
  if (msg.parts.some((p) => p.type === "text" && p.text.trim().length > 0)) return false;
  const toolParts = msg.parts.filter((p) => p.type === "tool_use");
  return toolParts.length > 0 && toolParts.every((p) => isGenericToolUse(p as ToolUsePart));
}

type RenderItem =
  | { kind: "message"; msg: NormalizedMessage }
  | { kind: "tool_batch"; toolUses: ToolUsePart[]; key: string };

// Collapse consecutive tool-only assistant messages (separated only by invisible
// tool_result user messages) into a single tool_batch render item.
function buildRenderItems(messages: NormalizedMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (isToolOnlyAssistantMessage(msg)) {
      const batchMsgs: AssistantMessage[] = [msg];
      let j = i + 1;

      // Look ahead: skip invisible tool_result user messages and collect more tool-only assistant messages
      while (j < messages.length) {
        const next = messages[j];
        if (next.role === "user" && next.parts.every((p) => p.type === "tool_result")) {
          j++;
        } else if (isToolOnlyAssistantMessage(next)) {
          batchMsgs.push(next);
          j++;
        } else {
          break;
        }
      }

      if (batchMsgs.length > 1) {
        // Multiple consecutive tool-only messages → single ToolGroupCard
        const toolUses: ToolUsePart[] = [];
        for (const m of batchMsgs) {
          for (const p of m.parts) {
            if (p.type === "tool_use") toolUses.push(p as ToolUsePart);
          }
        }
        items.push({ kind: "tool_batch", toolUses, key: `${msg.role}-${msg.index}` });
        i = j; // advance past all consumed messages (batch + skipped user messages)
      } else {
        // Only one tool-only message — render normally so MessageBubble handles it
        items.push({ kind: "message", msg });
        i++;
      }
    } else {
      items.push({ kind: "message", msg });
      i++;
    }
  }

  return items;
}
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
    currentMode, setMode, currentModel, approvePlan,
    connect, disconnect, sendPrompt, approve, approveAlways, deny, interrupt,
  } = useMessagesStore();
  const activeSession = useSessionsStore((s) => s.sessions.find((sess) => sess.id === id));
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const supportedModels = useSessionsStore((s) => s.supportedModels);

  useEffect(() => {
    if (activeSessionId && activeSessionId !== id) {
      navigate(`/session/${activeSessionId}`, { replace: true });
    }
  }, [activeSessionId, id, navigate]);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [showModeSwitcher, setShowModeSwitcher] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const modeSwitcherRef = useRef<HTMLDivElement>(null);
  // Track previous message count for scroll preservation on prepend
  const prevMessagesLenRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  // Flag to suppress auto-scroll after prepending older messages
  const justPrependedRef = useRef(false);

  const renderItems = useMemo(() => buildRenderItems(messages), [messages]);

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
      if (msg.role === "system" || msg.role === "tool_summary") continue;
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

  const canSwitchMode = status === "idle" || status === "completed" || status === "interrupted";

  useEffect(() => {
    if (!showModeSwitcher) return;
    const handler = (e: MouseEvent) => {
      if (!modeSwitcherRef.current?.contains(e.target as Node)) {
        setShowModeSwitcher(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModeSwitcher]);

  useEffect(() => {
    if (!showModelPicker) return;
    const handler = (e: MouseEvent) => {
      if (!modelPickerRef.current?.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelPicker]);

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
        {isDesktop && contextUsage && <ContextUsageBadge percentUsed={contextUsage.percentUsed} />}
        {isDesktop && currentModel && (
          <div className="relative" ref={modelPickerRef}>
            <Badge
              variant="outline"
              className={cn(
                "text-xs font-semibold uppercase tracking-wide cursor-pointer select-none",
                "bg-violet-500/15 text-violet-400 border-transparent",
                "hover:ring-1 hover:ring-current"
              )}
              onClick={() => setShowModelPicker((v) => !v)}
            >
              {modelLabel(currentModel, supportedModels?.find((m) => m.id === currentModel)?.name)}
            </Badge>
            {showModelPicker && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] bg-card border border-border rounded-lg shadow-xl overflow-hidden">
                <ModelPicker onSelect={() => setShowModelPicker(false)} />
              </div>
            )}
          </div>
        )}
        {isDesktop && currentMode && (
          <div className="relative" ref={modeSwitcherRef}>
            <Badge
              variant="outline"
              className={cn(
                "text-xs font-semibold uppercase tracking-wide cursor-pointer select-none",
                modeStyles[currentMode] || modeStyles.default,
                canSwitchMode && "hover:ring-1 hover:ring-current"
              )}
              onClick={() => canSwitchMode && setShowModeSwitcher((v) => !v)}
            >
              {modeLabels[currentMode] || currentMode}
            </Badge>
            {showModeSwitcher && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] bg-card border border-border rounded-lg shadow-xl overflow-hidden">
                {PERMISSION_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    className={cn(
                      "w-full px-3 py-2 text-sm text-left transition-colors",
                      currentMode === mode.value
                        ? "bg-primary/10 text-primary font-semibold"
                        : "text-foreground hover:bg-accent"
                    )}
                    onClick={() => {
                      setMode(mode.value);
                      setShowModeSwitcher(false);
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <Badge variant="outline" className={cn("text-xs font-semibold uppercase tracking-wide", statusStyles[status])}>
          {status}
        </Badge>
        {isDesktop && !connected && status !== "history" && (
          <Badge variant="outline" className={cn("text-xs font-semibold uppercase tracking-wide", statusStyles.disconnected)}>
            offline
          </Badge>
        )}
        {!isDesktop && (
          <SessionInfoSheet
            currentModel={currentModel}
            currentMode={currentMode}
            contextUsage={contextUsage}
            connected={connected}
            status={status}
            supportedModels={supportedModels}
            canSwitchMode={canSwitchMode}
            onSetMode={setMode}
          />
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
            {renderItems.map((item) =>
              item.kind === "tool_batch" ? (
                <ToolGroupCard
                  key={item.key}
                  toolUses={item.toolUses}
                  toolResults={toolResults}
                />
              ) : (
                <MessageBubble
                  key={`${item.msg.role}-${item.msg.index}`}
                  message={item.msg}
                  toolResults={toolResults}
                />
              )
            )}
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
        pendingApproval.targetMode ? (
          <PlanTransitionCard
            toolUseId={pendingApproval.toolUseId}
            planContent={
              pendingApproval.input != null &&
              typeof pendingApproval.input === "object" &&
              "plan" in (pendingApproval.input as Record<string, unknown>) &&
              typeof (pendingApproval.input as Record<string, unknown>).plan === "string"
                ? (pendingApproval.input as Record<string, unknown>).plan as string
                : null
            }
            onApprove={approvePlan}
            onDeny={(toolUseId, message) => deny(toolUseId, message)}
          />
        ) : (
          <ToolApproval
            toolName={pendingApproval.toolName}
            toolUseId={pendingApproval.toolUseId}
            input={pendingApproval.input}
            onApprove={approve}
            onApproveAlways={approveAlways}
            onDeny={deny}
          />
        )
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
