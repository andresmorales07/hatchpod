import { ClaudeAdapter } from "./claude-adapter.js";
const adapters = new Map();
export function registerProvider(adapter) {
    adapters.set(adapter.id, adapter);
}
export function getProvider(id) {
    const adapter = adapters.get(id);
    if (!adapter)
        throw new Error(`Unknown provider: ${id}`);
    return adapter;
}
export function listProviders() {
    return Array.from(adapters.values()).map((a) => ({ id: a.id, name: a.name }));
}
// Register built-in providers
registerProvider(new ClaudeAdapter());
// Register test provider only in test/development environments
if (process.env.NODE_ENV === "test" || process.env.ENABLE_TEST_PROVIDER === "1") {
    const { TestAdapter } = await import("./test-adapter.js");
    registerProvider(new TestAdapter());
}
