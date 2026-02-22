import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
function normalizeAssistant(msg, index, accumulatedThinking = "") {
    const content = msg.message?.content;
    if (!Array.isArray(content))
        return null;
    const parts = [];
    let hasNativeThinking = false;
    for (const block of content) {
        switch (block.type) {
            case "text":
                if (block.text)
                    parts.push({ type: "text", text: block.text });
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
    if (parts.length === 0)
        return null;
    return { role: "assistant", parts, index };
}
/**
 * Strip system/protocol XML tags from message text.
 * NOTE: Keep in sync with server/ui/src/lib/message-cleanup.ts
 *
 * Tags whose content is removed entirely. Add new entries as Claude Code
 * introduces new protocol tags.
 */
const SYSTEM_TAGS = [
    "system-reminder",
    "assistant_context",
    "task-notification",
    "user-prompt-submit-hook",
    "EXTREMELY_IMPORTANT",
    "EXTREMELY-IMPORTANT",
    "local-command-caveat",
    "command-message",
    "fast_mode_info",
];
const STRIP_RE = new RegExp(SYSTEM_TAGS.map((t) => `<${t}>[\\s\\S]*?</${t}>`).join("|"), "g");
/**
 * Full message cleanup: strip system tags, unwrap stdout, convert slash-command markup.
 * NOTE: Keep in sync with server/ui/src/lib/message-cleanup.ts cleanMessageText().
 */
function cleanMessageText(text) {
    // 1. Strip all known system/protocol XML blocks
    let cleaned = text.replace(STRIP_RE, "");
    // 2. Unwrap <local-command-stdout>...</local-command-stdout> to plain text
    cleaned = cleaned.replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, "$1");
    // 3. Convert <command-name>/<cmd></command-name> ... to clean "/cmd args"
    const m = cleaned.match(/^\s*<command-name>(\/[^<]+)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/);
    if (m) {
        const name = m[1].trim();
        const args = m[2]?.trim();
        cleaned = args ? `${name} ${args}` : name;
    }
    return cleaned.trim();
}
function normalizeUser(msg, index) {
    const inner = msg.message;
    if (!inner)
        return null;
    const parts = [];
    if (typeof inner.content === "string") {
        if (inner.content)
            parts.push({ type: "text", text: cleanMessageText(inner.content) });
    }
    else if (Array.isArray(inner.content)) {
        for (const block of inner.content) {
            if (block.type === "text" && block.text) {
                parts.push({ type: "text", text: cleanMessageText(block.text) });
            }
            else if (block.type === "tool_result") {
                const resultBlock = block;
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
    if (parts.length === 0)
        return null;
    return { role: "user", parts, index };
}
function normalizeResult(msg, index) {
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
function normalizeMessage(msg, index, accumulatedThinking = "") {
    switch (msg.type) {
        case "assistant":
            return normalizeAssistant(msg, index, accumulatedThinking);
        case "user":
            return normalizeUser(msg, index);
        case "result":
            return normalizeResult(msg, index);
        default:
            // system/init messages are handled via supportedCommands() after the stream
            return null;
    }
}
export class ClaudeAdapter {
    name = "Claude Code";
    id = "claude";
    async *run(options) {
        // Per-invocation index counter (safe for concurrent sessions)
        let messageIndex = 0;
        // Bridge AbortSignal → AbortController for the SDK
        const abortController = new AbortController();
        const onAbort = () => abortController.abort();
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
        let providerSessionId;
        let totalCostUsd = 0;
        let numTurns = 0;
        let accumulatedThinking = "";
        try {
            const queryHandle = sdkQuery({
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
                    canUseTool: options.permissionMode === "bypassPermissions"
                        ? undefined
                        : async (toolName, input, opts) => {
                            const decision = await options.onToolApproval({
                                toolName,
                                toolUseId: opts.toolUseID,
                                input,
                            });
                            if (decision.allow) {
                                return {
                                    behavior: "allow",
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
            const enrichedCommandsPromise = queryHandle.supportedCommands().then((sdkCommands) => sdkCommands.map((cmd) => ({
                name: cmd.name,
                description: cmd.description,
                argumentHint: cmd.argumentHint || undefined,
            })), (err) => {
                console.warn("Failed to fetch enriched slash commands (non-critical):", err);
                return null;
            });
            for await (const sdkMessage of queryHandle) {
                // Handle streaming thinking deltas (raw API events).
                // stream_events are raw API-level; only thinking_delta is forwarded.
                if (sdkMessage.type === "stream_event") {
                    const event = sdkMessage.event;
                    if (event?.type === "content_block_delta" &&
                        event.delta?.type === "thinking_delta") {
                        const thinking = event.delta?.thinking;
                        if (typeof thinking === "string") {
                            accumulatedThinking += thinking;
                            try {
                                options.onThinkingDelta?.(thinking);
                            }
                            catch (err) {
                                console.error("Failed to deliver thinking delta:", err);
                            }
                        }
                    }
                    continue;
                }
                // Capture result data before normalizing
                if (sdkMessage.type === "result") {
                    const resultMsg = sdkMessage;
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
        }
        finally {
            options.abortSignal.removeEventListener("abort", onAbort);
        }
        return { providerSessionId, totalCostUsd, numTurns };
    }
    async getSessionHistory(sessionId) {
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
        const messages = [];
        let messageIndex = 0;
        let skippedLines = 0;
        // Track the previous line's timestamp to compute thinking duration
        let prevTimestampMs = null;
        try {
            for await (const line of rl) {
                if (!line.trim())
                    continue;
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    skippedLines++;
                    continue;
                }
                const type = parsed.type;
                const lineTs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
                // Skip non-message lines but still track their timestamps
                if (type !== "user" && type !== "assistant") {
                    if (!Number.isNaN(lineTs))
                        prevTimestampMs = lineTs;
                    continue;
                }
                const msg = parsed.message;
                if (!msg)
                    continue;
                let normalized = null;
                if (type === "assistant") {
                    normalized = normalizeAssistant({ type: "assistant", message: msg }, messageIndex);
                    // Compute thinking duration from JSONL timestamps
                    if (normalized?.role === "assistant" &&
                        normalized.parts.some((p) => p.type === "reasoning") &&
                        prevTimestampMs != null &&
                        !Number.isNaN(lineTs) &&
                        lineTs > prevTimestampMs) {
                        normalized.thinkingDurationMs = lineTs - prevTimestampMs;
                    }
                }
                else if (type === "user") {
                    normalized = normalizeUser({ type: "user", message: msg }, messageIndex);
                }
                if (normalized) {
                    messages.push(normalized);
                    messageIndex++;
                }
                // Update prevTimestampMs for the next iteration
                if (!Number.isNaN(lineTs))
                    prevTimestampMs = lineTs;
            }
        }
        finally {
            if (skippedLines > 0) {
                console.warn(`getSessionHistory(${sessionId}): skipped ${skippedLines} unparseable JSONL line(s) in ${filePath}`);
            }
            rl.close();
            stream.destroy();
        }
        return messages;
    }
}
