import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
function normalizeAssistant(msg, index) {
    const content = msg.message?.content;
    if (!Array.isArray(content))
        return null;
    const parts = [];
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
                    parts.push({ type: "reasoning", text: block.thinking });
                }
                break;
        }
    }
    if (parts.length === 0)
        return null;
    return { role: "assistant", parts, index };
}
function normalizeUser(msg, index) {
    const inner = msg.message;
    if (!inner)
        return null;
    const parts = [];
    if (typeof inner.content === "string") {
        if (inner.content)
            parts.push({ type: "text", text: inner.content });
    }
    else if (Array.isArray(inner.content)) {
        for (const block of inner.content) {
            if (block.type === "text" && block.text) {
                parts.push({ type: "text", text: block.text });
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
function normalizeMessage(msg, index) {
    switch (msg.type) {
        case "assistant":
            return normalizeAssistant(msg, index);
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
                                return { behavior: "allow" };
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
                // Capture result data before normalizing
                if (sdkMessage.type === "result") {
                    const resultMsg = sdkMessage;
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
}
