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
} from "./types.js";

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
      case "text":
        if (block.text) parts.push({ type: "text", text: block.text });
        break;
      case "tool_use":
        if (block.id && block.name) {
          parts.push({
            type: "tool_use",
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
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

/**
 * Clean SDK-internal XML markup from user message text.
 * NOTE: Keep in sync with server/ui/src/components/MessageBubble.tsx cleanSdkMarkup().
 * Handles:
 *  - <command-name>/<cmd></command-name> ... → "/cmd args"
 *  - <local-command-caveat>...</local-command-caveat> → stripped entirely
 *  - <local-command-stdout>...</local-command-stdout> → unwrapped to plain text
 */
function cleanSdkMarkup(text: string): string {
  // Strip <local-command-caveat>...</local-command-caveat> blocks (LLM-only instructions)
  let cleaned = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "");

  // Unwrap <local-command-stdout>...</local-command-stdout> to plain text
  cleaned = cleaned.replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, "$1");

  // Convert <command-name>/<cmd></command-name> ... to clean "/cmd args"
  const m = cleaned.match(
    /^\s*<command-name>(\/[^<]+)<\/command-name>\s*<command-message>[\s\S]*?<\/command-message>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/,
  );
  if (m) {
    const name = m[1].trim();
    const args = m[2]?.trim();
    cleaned = args ? `${name} ${args}` : name;
  }

  return cleaned.trim();
}

function normalizeUser(msg: SDKUserMessage | SDKUserMessageReplay, index: number): NormalizedMessage | null {
  const inner = msg.message;
  if (!inner) return null;

  const parts: MessagePart[] = [];
  if (typeof inner.content === "string") {
    if (inner.content) parts.push({ type: "text", text: cleanSdkMarkup(inner.content) });
  } else if (Array.isArray(inner.content)) {
    for (const block of inner.content as ContentBlock[]) {
      if (block.type === "text" && block.text) {
        parts.push({ type: "text", text: cleanSdkMarkup(block.text) });
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
  switch (msg.type) {
    case "assistant":
      return normalizeAssistant(msg as SDKAssistantMessage, index, accumulatedThinking);
    case "user":
      return normalizeUser(msg as SDKUserMessage | SDKUserMessageReplay, index);
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

    try {
      const queryHandle: Query = sdkQuery({
        prompt: options.prompt,
        options: {
          abortController,
          maxTurns: options.maxTurns ?? 50,
          cwd: options.cwd,
          permissionMode: options.permissionMode,
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
                    return {
                      behavior: "allow" as const,
                      ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
                      ...(decision.alwaysAllow && opts.suggestions
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
        // Handle streaming thinking deltas (raw API events).
        // stream_events are raw API-level; only thinking_delta is forwarded.
        if (sdkMessage.type === "stream_event") {
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

  async getSessionHistory(sessionId: string): Promise<NormalizedMessage[]> {
    const { findSessionFile } = await import("../session-history.js");
    const filePath = await findSessionFile(sessionId);
    if (!filePath) {
      const err = new Error(`Session file not found for ${sessionId}`);
      err.name = "SessionNotFound";
      throw err;
    }

    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");

    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    const messages: NormalizedMessage[] = [];
    let messageIndex = 0;
    let skippedLines = 0;
    // Track the previous line's timestamp to compute thinking duration
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

        // Skip non-message lines but still track their timestamps
        if (type !== "user" && type !== "assistant") {
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
          // Compute thinking duration from JSONL timestamps
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

        // Update prevTimestampMs for the next iteration
        if (!Number.isNaN(lineTs)) prevTimestampMs = lineTs;
      }
    } finally {
      if (skippedLines > 0) {
        console.warn(
          `getSessionHistory(${sessionId}): skipped ${skippedLines} unparseable JSONL line(s) in ${filePath}`,
        );
      }
      rl.close();
      stream.destroy();
    }

    return messages;
  }
}
