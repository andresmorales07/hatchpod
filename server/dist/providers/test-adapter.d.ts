import type { ProviderAdapter, ProviderSessionOptions, ProviderSessionResult, NormalizedMessage, PaginatedMessages, SessionListItem } from "./types.js";
export declare class TestAdapter implements ProviderAdapter {
    readonly name = "Test Provider";
    readonly id = "test";
    run(options: ProviderSessionOptions): AsyncGenerator<NormalizedMessage, ProviderSessionResult, undefined>;
    getSessionHistory(_sessionId: string): Promise<NormalizedMessage[]>;
    getMessages(_sessionId: string, _options?: {
        before?: number;
        limit?: number;
    }): Promise<PaginatedMessages>;
    listSessions(_cwd?: string): Promise<SessionListItem[]>;
    getSessionFilePath(_sessionId: string): Promise<string | null>;
    normalizeFileLine(_line: string, _index: number): NormalizedMessage | null;
}
