import type { ProviderAdapter } from "./types.js";
export declare function registerProvider(adapter: ProviderAdapter): void;
export declare function getProvider(id: string): ProviderAdapter;
export declare function listProviders(): Array<{
    id: string;
    name: string;
}>;
