import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  SlashCommand as SDKSlashCommand,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderAdapter,
  ProviderSessionOptions,
  ProviderSessionResult,
  NormalizedMessage,
  MessagePart,
  SlashCommand,
  PaginatedMessages,
  SessionListItem,
} from "./types.js";
import { cleanMessageText } from "./message-cleanup.js";
import { getToolSummary } from "./tool-summary.js";

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

function normalizeAssistant(msg: SDKAssistantMessage, index: number, accumulatedThinking = ""): NormalizedMessage | null {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;

  const parts: MessagePart[] = [];
  let hasNativeThinking = false;
  for (const block of content as ContentBlock[]) {
    switch (block.type) {
      case "text": {
        if (!block.text) break;
        const cleaned = cleanMessageText(block.text);
        if (cleaned) parts.push({ type: "text", text: cleaned });
        break;
      }
      case "tool_use":
        if (block.id && block.name) {
          parts.push({
            type: "tool_use",
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
            summary: getToolSummary(block.name, block.input),
          });
        }
        break;
      case "thinking":
        if (block.thinking) {
          hasNativeThinking = true;
          parts.push({ type: "reasoning", text: block.thinking });
        }
        break;
    }
  }

  // Inject accumulated thinking from stream deltas if the SDK didn't
  // include a native thinking block in the finalized message content
  if (!hasNativeThinking && accumulatedThinking) {
    parts.unshift({ type: "reasoning", text: accumulatedThinking });
  }

  if (parts.length === 0) return null;
  return { role: "assistant", parts, index };
}

function normalizeUser(msg: SDKUserMessage | SDKUserMessageReplay, index: number): NormalizedMessage | null {
  const inner = msg.message;
  if (!inner) return null;

  const parts: MessagePart[] = [];
  if (typeof inner.content === "string") {
    if (inner.content) parts.push({ type: "text", text: cleanMessageText(inner.content) });
  } else if (Array.isArray(inner.content)) {
    for (const block of inner.content as ContentBlock[]) {
      if (block.type === "text" && block.text) {
        parts.push({ type: "text", text: cleanMessageText(block.text) });
      } else if (block.type === "tool_result") {
        const resultBlock = block as unknown as {
          type: string;
          tool_use_id?: string;
          content?: string | Array<{ type: string; text?: string }>;
          is_error?: boolean;
        };
        const output = typeof resultBlock.content === "string"
          ? resultBlock.content
          : Array.isArray(resultBlock.content)
            ? resultBlock.content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text)
                .join("")
            : "";
        parts.push({
          type: "tool_result",
          toolUseId: resultBlock.tool_use_id ?? "",
          output,
          isError: resultBlock.is_error ?? false,
        });
      }
    }
  }

  if (parts.length === 0) return null;
  return { role: "user", parts, index };
}

function normalizeResult(msg: SDKResultMessage, index: number): NormalizedMessage {
  return {
    role: "system",
    event: {
      type: "session_result",
      totalCostUsd: msg.total_cost_usd,
      numTurns: msg.num_turns,
    },
    index,
  };
}

function normalizeMessage(msg: SDKMessage, index: number, accumulatedThinking = ""): NormalizedMessage | null {
  // Drop sidechain messages — these belong to a subagent's internal stream and are
  // never written to the parent session JSONL. Filtering here keeps the live stream
  // consistent with what history replay shows.
  if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id != null) {
    return null;
  }

  switch (msg.type) {
    case "assistant":
      return normalizeAssistant(msg as SDKAssistantMessage, index, accumulatedThinking);
    case "user": {
      // Skip system-injected user messages (skill content, system context, etc.)
      const userMsg = msg as SDKUserMessage | SDKUserMessageReplay;
      if ((userMsg as Record<string, unknown>).isMeta || (userMsg as Record<string, unknown>).isSynthetic) {
        return null;
      }
      return normalizeUser(userMsg, index);
    }
    case "result":
      return normalizeResult(msg as SDKResultMessage, index);
    default:
      // system/init messages are handled via supportedCommands() after the stream
      return null;
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "Claude Code";
  readonly id = "claude";

  async *run(
    options: ProviderSessionOptions,
  ): AsyncGenerator<NormalizedMessage, ProviderSessionResult, undefined> {
    // Per-invocation index counter (safe for concurrent sessions)
    let messageIndex = 0;

    // Bridge AbortSignal → AbortController for the SDK
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    options.abortSignal.addEventListener("abort", onAbort, { once: true });

    let providerSessionId: string | undefined;
    let totalCostUsd = 0;
    let numTurns = 0;
    let accumulatedThinking = "";
    const taskIdToToolUseId = new Map<string, string>();

    try {
      const queryHandle: Query = sdkQuery({
        prompt: options.prompt,
        options: {
          abortController,
          maxTurns: options.maxTurns ?? 50,
          cwd: options.cwd,
          permissionMode: options.permissionMode,
          systemPrompt: { type: "preset", preset: "claude_code" },
          thinking: { type: "adaptive" },
          ...(options.permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.allowedTools?.length
            ? { allowedTools: options.allowedTools }
            : {}),
          ...(options.resumeSessionId
            ? { resume: options.resumeSessionId }
            : {}),
          settingSources: ["user", "project", "local"],
          includePartialMessages: true,
          canUseTool:
            options.permissionMode === "bypassPermissions"
              ? undefined
              : async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: {
                    toolUseID: string;
                    suggestions?: PermissionUpdate[];
                  },
                ): Promise<PermissionResult> => {
                  const decision = await options.onToolApproval({
                    toolName,
                    toolUseId: opts.toolUseID,
                    input,
                  });
                  if (decision.allow) {
                    // ExitPlanMode and EnterPlanMode need updatedPermissions
                    // (containing setMode transitions) even without alwaysAllow,
                    // otherwise the SDK clears context and restarts the query
                    // as a new session instead of continuing in-place.
                    const needsPermissionUpdate =
                      decision.alwaysAllow ||
                      toolName === "ExitPlanMode" ||
                      toolName === "EnterPlanMode";
                    return {
                      behavior: "allow" as const,
                      updatedInput: decision.updatedInput ?? input,
                      ...(needsPermissionUpdate && opts.suggestions
                        ? { updatedPermissions: opts.suggestions }
                        : {}),
                    };
                  }
                  return {
                    behavior: "deny",
                    message: decision.message ?? "Denied by user",
                  };
                },
        },
      });

      // Eagerly fetch enriched slash commands (with descriptions)
      const enrichedCommandsPromise = queryHandle.supportedCommands().then(
        (sdkCommands: SDKSlashCommand[]) =>
          sdkCommands.map((cmd): SlashCommand => ({
            name: cmd.name,
            description: cmd.description,
            argumentHint: cmd.argumentHint || undefined,
          })),
        (err) => {
          console.warn("Failed to fetch enriched slash commands (non-critical):", err);
          return null;
        },
      );

      for await (const sdkMessage of queryHandle) {
        // Handle subagent lifecycle messages (task_started / task_notification)
        if (sdkMessage.type === "system") {
          const sysMsg = sdkMessage as { type: string; subtype?: string; [key: string]: unknown };
          if (sysMsg.subtype === "task_started") {
            if (typeof sysMsg.tool_use_id !== "string" || !sysMsg.tool_use_id) {
              console.warn("claude-adapter: task_started missing tool_use_id", sysMsg);
            } else if (typeof sysMsg.task_id !== "string" || !sysMsg.task_id) {
              console.warn("claude-adapter: task_started missing task_id", sysMsg);
            } else {
              taskIdToToolUseId.set(sysMsg.task_id, sysMsg.tool_use_id);
              try {
                options.onSubagentStarted?.({
                  taskId: sysMsg.task_id,
                  toolUseId: sysMsg.tool_use_id,
                  description: (sysMsg.description as string) || "Running subagent",
                  agentType: typeof sysMsg.task_type === "string" && sysMsg.task_type ? sysMsg.task_type : undefined,
                });
              } catch (err) {
                console.error(`claude-adapter: onSubagentStarted callback failed for taskId="${sysMsg.task_id}" toolUseId="${sysMsg.tool_use_id}":`, err);
              }
            }
          } else if (sysMsg.subtype === "task_notification") {
            const toolUseId = taskIdToToolUseId.get(sysMsg.task_id as string);
            if (toolUseId) {
              const rawStatus = (sysMsg.status as string) ?? "completed";
              const statusMap: Record<string, "completed" | "failed" | "stopped"> = {
                completed: "completed",
                failed: "failed",
                stopped: "stopped",
              };
              const status = statusMap[rawStatus] ?? "completed";
              try {
                options.onSubagentCompleted?.({
                  taskId: sysMsg.task_id as string,
                  toolUseId,
                  status,
                  summary: (sysMsg.summary as string) ?? "",
                });
              } catch (err) {
                console.error(`claude-adapter: onSubagentCompleted callback failed for taskId="${sysMsg.task_id as string}" toolUseId="${toolUseId}":`, err);
              }
              taskIdToToolUseId.delete(sysMsg.task_id as string);
            } else {
              console.warn(
                `claude-adapter: task_notification for unknown task_id "${sysMsg.task_id}" — no matching task_started received. Subagent card may be stuck.`,
              );
            }
          } else if (sysMsg.subtype !== undefined) {
            console.warn(`claude-adapter: unhandled system subtype "${sysMsg.subtype}"`, sysMsg);
          }
          continue;
        }

        // Extract subagent tool calls from sidechain assistant messages
        const parentToolUseId = (sdkMessage as { parent_tool_use_id?: string | null }).parent_tool_use_id;
        if (parentToolUseId != null && sdkMessage.type === "assistant") {
          const content = (sdkMessage as { message?: { content?: unknown[] } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content as ContentBlock[]) {
              if (block.type === "tool_use" && block.name) {
                try {
                  options.onSubagentToolCall?.({
                    toolUseId: parentToolUseId,
                    toolName: block.name,
                    summary: getToolSummary(block.name, block.input),
                  });
                } catch (err) {
                  console.error(`claude-adapter: onSubagentToolCall callback failed for toolUseId="${parentToolUseId}" toolName="${block.name}":`, err);
                }
              }
            }
          }
        }

        // Handle streaming thinking deltas (raw API events).
        // stream_events are raw API-level; only thinking_delta is forwarded.
        if (sdkMessage.type === "stream_event") {
          // Skip sidechain stream events (subagent thinking deltas)
          if ((sdkMessage as { parent_tool_use_id?: string | null }).parent_tool_use_id != null) {
            continue;
          }
          const event = (sdkMessage as { type: string; event: Record<string, unknown> }).event;
          if (
            event?.type === "content_block_delta" &&
            (event.delta as Record<string, unknown>)?.type === "thinking_delta"
          ) {
            const thinking = (event.delta as Record<string, unknown>)?.thinking;
            if (typeof thinking === "string") {
              accumulatedThinking += thinking;
              try {
                options.onThinkingDelta?.(thinking);
              } catch (err) {
                console.error("Failed to deliver thinking delta:", err);
              }
            }
          }
          continue;
        }

        // Capture result data before normalizing
        if (sdkMessage.type === "result") {
          const resultMsg = sdkMessage as SDKResultMessage;
          totalCostUsd = resultMsg.total_cost_usd;
          numTurns = resultMsg.num_turns;
          if (resultMsg.session_id) {
            providerSessionId = resultMsg.session_id;
          }
        }

        // Only pass accumulated thinking to assistant messages; reset after use
        let thinkingForMsg = "";
        if (sdkMessage.type === "assistant") {
          thinkingForMsg = accumulatedThinking;
          accumulatedThinking = "";
        }

        const normalized = normalizeMessage(sdkMessage, messageIndex, thinkingForMsg);
        if (normalized) {
          messageIndex++;
          yield normalized;
        }
      }

      // Yield enriched slash commands if available
      const enrichedCommands = await enrichedCommandsPromise;
      if (enrichedCommands && enrichedCommands.length > 0) {
        yield {
          role: "system",
          event: { type: "system_init", slashCommands: enrichedCommands },
          index: messageIndex++,
        };
      }
    } finally {
      options.abortSignal.removeEventListener("abort", onAbort);
    }

    return { providerSessionId, totalCostUsd, numTurns };
  }

  /**
   * Parse all messages from a JSONL file into normalized messages.
   * Computes thinking duration from timestamps and attaches tool summaries.
   */
  private async _parseAllMessages(filePath: string): Promise<NormalizedMessage[]> {
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");

    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    const messages: NormalizedMessage[] = [];
    let messageIndex = 0;
    let skippedLines = 0;
    let prevTimestampMs: number | null = null;

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          skippedLines++;
          continue;
        }

        const type = parsed.type;
        const lineTs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;

        if (type !== "user" && type !== "assistant") {
          if (!Number.isNaN(lineTs)) prevTimestampMs = lineTs;
          continue;
        }

        if (parsed.isMeta || parsed.isSynthetic) {
          if (!Number.isNaN(lineTs)) prevTimestampMs = lineTs;
          continue;
        }

        const msg = parsed.message as Record<string, unknown> | undefined;
        if (!msg) continue;

        let normalized: NormalizedMessage | null = null;
        if (type === "assistant") {
          normalized = normalizeAssistant(
            { type: "assistant", message: msg } as unknown as SDKAssistantMessage,
            messageIndex,
          );
          if (
            normalized?.role === "assistant" &&
            normalized.parts.some((p) => p.type === "reasoning") &&
            prevTimestampMs != null &&
            !Number.isNaN(lineTs) &&
            lineTs > prevTimestampMs
          ) {
            normalized.thinkingDurationMs = lineTs - prevTimestampMs;
          }
        } else if (type === "user") {
          normalized = normalizeUser(
            { type: "user", message: msg } as unknown as SDKUserMessage,
            messageIndex,
          );
        }

        if (normalized) {
          messages.push(normalized);
          messageIndex++;
        }

        if (!Number.isNaN(lineTs)) prevTimestampMs = lineTs;
      }
    } finally {
      if (skippedLines > 0) {
        console.warn(
          `_parseAllMessages: skipped ${skippedLines} unparseable JSONL line(s) in ${filePath}`,
        );
      }
      rl.close();
      stream.destroy();
    }

    return messages;
  }

  async getSessionHistory(sessionId: string): Promise<NormalizedMessage[]> {
    const { findSessionFile } = await import("../session-history.js");
    const filePath = await findSessionFile(sessionId);
    if (!filePath) {
      const err = new Error(`Session file not found for ${sessionId}`);
      err.name = "SessionNotFound";
      throw err;
    }
    return this._parseAllMessages(filePath);
  }

  async getMessages(
    sessionId: string,
    options?: { before?: number; limit?: number },
  ): Promise<PaginatedMessages> {
    const filePath = await this.getSessionFilePath(sessionId);
    if (!filePath) {
      const err = new Error(`Session file not found for ${sessionId}`);
      err.name = "SessionNotFound";
      throw err;
    }

    const allMessages = await this._parseAllMessages(filePath);

    const { extractTasks } = await import("../task-extractor.js");
    const tasks = extractTasks(allMessages);

    const before = options?.before ?? allMessages.length;
    const limit = Math.min(Math.max(options?.limit ?? 30, 1), 100);

    const eligible = allMessages.filter((m) => m.index < before);
    const page = eligible.slice(-limit);
    const oldestIndex = page.length > 0 ? page[0].index : 0;
    const hasMore = eligible.length > page.length;

    return {
      messages: page,
      tasks,
      totalMessages: allMessages.length,
      hasMore,
      oldestIndex,
    };
  }

  async listSessions(cwd?: string): Promise<SessionListItem[]> {
    const { listSessionHistory, listAllSessionHistory } = await import("../session-history.js");
    const history = await (cwd ? listSessionHistory(cwd) : listAllSessionHistory());
    return history.map((h) => ({
      id: h.id,
      slug: h.slug,
      summary: h.summary,
      cwd: h.cwd,
      lastModified: h.lastModified.toISOString(),
      createdAt: h.createdAt.toISOString(),
    }));
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const { findSessionFile } = await import("../session-history.js");
    return findSessionFile(sessionId);
  }

  normalizeFileLine(line: string, index: number): NormalizedMessage | null {
    if (!line.trim()) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      console.warn(`normalizeFileLine: failed to parse JSONL at index ${index}:`, (err as Error).message);
      return null;
    }

    const type = parsed.type;
    if (type !== "user" && type !== "assistant") return null;

    // Skip system-injected user messages (skill content, system context, etc.)
    if (parsed.isMeta || parsed.isSynthetic) return null;

    const msg = parsed.message as Record<string, unknown> | undefined;
    if (!msg) return null;

    if (type === "assistant") {
      return normalizeAssistant(
        { type: "assistant", message: msg } as unknown as SDKAssistantMessage,
        index,
      );
    }

    return normalizeUser(
      { type: "user", message: msg } as unknown as SDKUserMessage,
      index,
    );
  }
}
