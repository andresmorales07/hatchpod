import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderAdapter,
  ProviderSessionOptions,
  ProviderSessionResult,
  NormalizedMessage,
  MessagePart,
} from "./types.js";

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

function normalizeAssistant(msg: SDKAssistantMessage, index: number): NormalizedMessage | null {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;

  const parts: MessagePart[] = [];
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
          parts.push({ type: "reasoning", text: block.thinking });
        }
        break;
    }
  }

  if (parts.length === 0) return null;
  return { role: "assistant", parts, index };
}

function normalizeUser(msg: SDKUserMessage | SDKUserMessageReplay, index: number): NormalizedMessage | null {
  const inner = msg.message;
  if (!inner) return null;

  const parts: MessagePart[] = [];
  if (typeof inner.content === "string") {
    if (inner.content) parts.push({ type: "text", text: inner.content });
  } else if (Array.isArray(inner.content)) {
    for (const block of inner.content as ContentBlock[]) {
      if (block.type === "text" && block.text) {
        parts.push({ type: "text", text: block.text });
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

function normalizeMessage(msg: SDKMessage, index: number): NormalizedMessage | null {
  switch (msg.type) {
    case "assistant":
      return normalizeAssistant(msg as SDKAssistantMessage, index);
    case "user":
      return normalizeUser(msg as SDKUserMessage | SDKUserMessageReplay, index);
    case "result":
      return normalizeResult(msg as SDKResultMessage, index);
    default:
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
          includePartialMessages: true,
          canUseTool:
            options.permissionMode === "bypassPermissions"
              ? undefined
              : async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string },
                ): Promise<PermissionResult> => {
                  const decision = await options.onToolApproval({
                    toolName,
                    toolUseId: opts.toolUseID,
                    input,
                  });
                  if (decision.allow) {
                    return { behavior: "allow" };
                  }
                  return {
                    behavior: "deny",
                    message: decision.message ?? "Denied by user",
                  };
                },
        },
      });

      for await (const sdkMessage of queryHandle) {
        // Capture result data before normalizing
        if (sdkMessage.type === "result") {
          const resultMsg = sdkMessage as SDKResultMessage;
          totalCostUsd = resultMsg.total_cost_usd;
          numTurns = resultMsg.num_turns;
          if (resultMsg.session_id) {
            providerSessionId = resultMsg.session_id;
          }
        }

        const normalized = normalizeMessage(sdkMessage, messageIndex);
        if (normalized) {
          messageIndex++;
          yield normalized;
        }
      }
    } finally {
      options.abortSignal.removeEventListener("abort", onAbort);
    }

    return { providerSessionId, totalCostUsd, numTurns };
  }
}
