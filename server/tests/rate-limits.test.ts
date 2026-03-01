import { describe, it, expect, beforeEach } from "vitest";
import { getCachedRateLimits, updateCachedRateLimits, clearCachedRateLimits } from "../src/rate-limits.js";

describe("rate-limits cache", () => {
  beforeEach(() => {
    clearCachedRateLimits();
  });

  it("returns null when no data cached", () => {
    expect(getCachedRateLimits()).toBeNull();
  });

  it("stores and retrieves rate limit info", () => {
    const info = { status: "allowed" as const, rateLimitType: "five_hour" as const, utilization: 0.42 };
    updateCachedRateLimits(info);
    const cached = getCachedRateLimits();
    expect(cached).not.toBeNull();
    expect(cached!.info).toEqual(info);
    expect(cached!.lastUpdated).toBeTruthy();
  });

  it("overwrites previous data on update", () => {
    updateCachedRateLimits({ status: "allowed" as const, utilization: 0.5 });
    updateCachedRateLimits({ status: "allowed_warning" as const, utilization: 0.85 });
    const cached = getCachedRateLimits();
    expect(cached!.info.status).toBe("allowed_warning");
    expect(cached!.info.utilization).toBe(0.85);
  });

  it("clears cache", () => {
    updateCachedRateLimits({ status: "allowed" as const });
    clearCachedRateLimits();
    expect(getCachedRateLimits()).toBeNull();
  });
});
