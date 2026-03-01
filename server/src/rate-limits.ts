import type { RateLimitInfo, CachedRateLimitResponse } from "./schemas/index.js";

let cached: CachedRateLimitResponse | null = null;

export function getCachedRateLimits(): CachedRateLimitResponse | null {
  return cached;
}

export function updateCachedRateLimits(info: RateLimitInfo): void {
  cached = { info, lastUpdated: new Date().toISOString() };
}

export function clearCachedRateLimits(): void {
  cached = null;
}
