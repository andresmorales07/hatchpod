import type { ProviderAdapter, ProviderSessionOptions, ProviderSessionResult, NormalizedMessage } from "./types.js";
export declare class ClaudeAdapter implements ProviderAdapter {
    readonly name = "Claude Code";
    readonly id = "claude";
    run(options: ProviderSessionOptions): AsyncGenerator<NormalizedMessage, ProviderSessionResult, undefined>;
    getSessionHistory(sessionId: string): Promise<NormalizedMessage[]>;
}
