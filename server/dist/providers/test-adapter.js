import { randomUUID } from "node:crypto";
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("aborted"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function checkAbort(signal) {
    if (signal.aborted)
        throw new Error("aborted");
}
export class TestAdapter {
    name = "Test Provider";
    id = "test";
    async *run(options) {
        const { prompt, abortSignal, onToolApproval } = options;
        let index = 0;
        // Parse scenario tag from prompt prefix
        const tagMatch = prompt.match(/^\[([a-z-]+)\]\s*/);
        const scenario = tagMatch ? tagMatch[1] : "echo";
        const cleanPrompt = tagMatch ? prompt.slice(tagMatch[0].length) : prompt;
        switch (scenario) {
            case "error": {
                // Yield one message, then throw
                checkAbort(abortSignal);
                yield {
                    role: "assistant",
                    parts: [{ type: "text", text: `Echo: ${cleanPrompt}` }],
                    index: index++,
                };
                throw new Error("Simulated provider error");
            }
            case "tool-approval": {
                checkAbort(abortSignal);
                const toolUseId = randomUUID();
                // Yield a tool_use message
                yield {
                    role: "assistant",
                    parts: [
                        {
                            type: "tool_use",
                            toolUseId,
                            toolName: "test_tool",
                            input: { action: "test" },
                        },
                    ],
                    index: index++,
                };
                // Request approval
                checkAbort(abortSignal);
                const decision = await onToolApproval({
                    toolName: "test_tool",
                    toolUseId,
                    input: { action: "test" },
                });
                checkAbort(abortSignal);
                if (decision.allow) {
                    // Yield tool_result then final text
                    yield {
                        role: "user",
                        parts: [
                            {
                                type: "tool_result",
                                toolUseId,
                                output: "Tool executed successfully",
                                isError: false,
                            },
                        ],
                        index: index++,
                    };
                    yield {
                        role: "assistant",
                        parts: [{ type: "text", text: "Tool was approved and executed." }],
                        index: index++,
                    };
                }
                else {
                    yield {
                        role: "user",
                        parts: [
                            {
                                type: "tool_result",
                                toolUseId,
                                output: decision.message ?? "Denied by user",
                                isError: true,
                            },
                        ],
                        index: index++,
                    };
                    yield {
                        role: "assistant",
                        parts: [{ type: "text", text: "Tool was denied." }],
                        index: index++,
                    };
                }
                break;
            }
            case "tool-approval-multi": {
                // Two consecutive tool approval requests for the same tool.
                // If "always allow" was used on the first, the second auto-approves.
                checkAbort(abortSignal);
                const toolUseId1 = randomUUID();
                yield {
                    role: "assistant",
                    parts: [{ type: "tool_use", toolUseId: toolUseId1, toolName: "test_tool", input: { step: 1 } }],
                    index: index++,
                };
                checkAbort(abortSignal);
                const decision1 = await onToolApproval({
                    toolName: "test_tool",
                    toolUseId: toolUseId1,
                    input: { step: 1 },
                });
                checkAbort(abortSignal);
                yield {
                    role: "user",
                    parts: [{ type: "tool_result", toolUseId: toolUseId1, output: decision1.allow ? "ok" : "denied", isError: !decision1.allow }],
                    index: index++,
                };
                // Second call — same toolName; should auto-approve if "always allow" was used on first
                const toolUseId2 = randomUUID();
                yield {
                    role: "assistant",
                    parts: [{ type: "tool_use", toolUseId: toolUseId2, toolName: "test_tool", input: { step: 2 } }],
                    index: index++,
                };
                checkAbort(abortSignal);
                const decision2 = await onToolApproval({
                    toolName: "test_tool",
                    toolUseId: toolUseId2,
                    input: { step: 2 },
                });
                checkAbort(abortSignal);
                yield {
                    role: "user",
                    parts: [{ type: "tool_result", toolUseId: toolUseId2, output: decision2.allow ? "ok" : "denied", isError: !decision2.allow }],
                    index: index++,
                };
                yield {
                    role: "assistant",
                    parts: [{ type: "text", text: `first:${decision1.allow} second:${decision2.allow}` }],
                    index: index++,
                };
                break;
            }
            case "multi-turn": {
                checkAbort(abortSignal);
                // 1. Assistant text
                yield {
                    role: "assistant",
                    parts: [{ type: "text", text: "Starting multi-turn sequence." }],
                    index: index++,
                };
                checkAbort(abortSignal);
                // 2. Tool use
                const toolUseId = randomUUID();
                yield {
                    role: "assistant",
                    parts: [
                        {
                            type: "tool_use",
                            toolUseId,
                            toolName: "multi_tool",
                            input: { step: 1 },
                        },
                    ],
                    index: index++,
                };
                checkAbort(abortSignal);
                // 3. Tool result
                yield {
                    role: "user",
                    parts: [
                        {
                            type: "tool_result",
                            toolUseId,
                            output: "Step 1 complete",
                            isError: false,
                        },
                    ],
                    index: index++,
                };
                checkAbort(abortSignal);
                // 4. Final assistant text
                yield {
                    role: "assistant",
                    parts: [{ type: "text", text: "Multi-turn sequence complete." }],
                    index: index++,
                };
                break;
            }
            case "slow": {
                // 5 messages with 100ms delays, checks abortSignal between each
                for (let i = 0; i < 5; i++) {
                    checkAbort(abortSignal);
                    yield {
                        role: "assistant",
                        parts: [{ type: "text", text: `Slow message ${i + 1} of 5` }],
                        index: index++,
                    };
                    if (i < 4) {
                        await delay(100, abortSignal);
                    }
                }
                break;
            }
            case "slash-commands": {
                checkAbort(abortSignal);
                // Echo the prompt
                yield {
                    role: "assistant",
                    parts: [{ type: "text", text: `Echo: ${cleanPrompt}` }],
                    index: index++,
                };
                checkAbort(abortSignal);
                // Yield system_init with mock slash commands
                yield {
                    role: "system",
                    event: {
                        type: "system_init",
                        slashCommands: [
                            { name: "/test", description: "A test command" },
                            { name: "/help", description: "Show help", argumentHint: "[topic]" },
                        ],
                    },
                    index: index++,
                };
                break;
            }
            case "remap": {
                // Yields a message and returns a different providerSessionId,
                // triggering the session ID remap flow in runSession().
                checkAbort(abortSignal);
                yield {
                    role: "assistant",
                    parts: [{ type: "text", text: `Echo: ${cleanPrompt}` }],
                    index: index++,
                };
                return {
                    providerSessionId: randomUUID(),
                    totalCostUsd: 0.001,
                    numTurns: 1,
                };
            }
            case "thinking": {
                // Simulate streaming thinking deltas
                checkAbort(abortSignal);
                options.onThinkingDelta?.("I need to ");
                await delay(50, abortSignal);
                options.onThinkingDelta?.("analyze this ");
                await delay(50, abortSignal);
                options.onThinkingDelta?.("request carefully.");
                checkAbort(abortSignal);
                // Yield the complete assistant message with reasoning + text
                yield {
                    role: "assistant",
                    parts: [
                        { type: "reasoning", text: "I need to analyze this request carefully." },
                        { type: "text", text: "Here is my response." },
                    ],
                    index: index++,
                };
                break;
            }
            default: {
                // Echo scenario (default)
                checkAbort(abortSignal);
                yield {
                    role: "assistant",
                    parts: [{ type: "text", text: `Echo: ${cleanPrompt}` }],
                    index: index++,
                };
                break;
            }
        }
        return {
            totalCostUsd: 0.001,
            numTurns: Math.max(1, index),
        };
    }
    async getSessionFilePath(_sessionId) {
        return null; // Test adapter doesn't write to disk
    }
    normalizeFileLine(_line, _index) {
        return null; // Test adapter doesn't use file-based messages
    }
}
