import type { ProviderAdapter, ProviderSessionOptions, ProviderSessionResult, NormalizedMessage } from "./types.js";
export declare class TestAdapter implements ProviderAdapter {
    readonly name = "Test Provider";
    readonly id = "test";
    run(options: ProviderSessionOptions): AsyncGenerator<NormalizedMessage, ProviderSessionResult, undefined>;
    getSessionFilePath(_sessionId: string): Promise<string | null>;
    normalizeFileLine(_line: string, _index: number): NormalizedMessage | null;
}
