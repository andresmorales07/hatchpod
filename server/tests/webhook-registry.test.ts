import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebhookRegistry } from "../src/webhooks.js";

describe("WebhookRegistry", () => {
  let dir: string;
  let registry: WebhookRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "webhooks-"));
    registry = new WebhookRegistry(join(dir, "webhooks.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts with empty list", async () => {
    const all = await registry.list();
    expect(all).toEqual([]);
  });

  it("creates a webhook and assigns id + createdAt", async () => {
    const wh = await registry.create({ name: "Test", url: "https://example.com/hook", events: [] });
    expect(wh.id).toBeDefined();
    expect(wh.createdAt).toBeDefined();
    expect(wh.enabled).toBe(true);
    const all = await registry.list();
    expect(all).toHaveLength(1);
  });

  it("updates a webhook", async () => {
    const wh = await registry.create({ name: "Test", url: "https://example.com/hook", events: [] });
    const updated = await registry.update(wh.id, { name: "Updated" });
    expect(updated.name).toBe("Updated");
    expect(updated.url).toBe("https://example.com/hook");
  });

  it("deletes a webhook", async () => {
    const wh = await registry.create({ name: "Test", url: "https://example.com/hook", events: [] });
    await registry.remove(wh.id);
    expect(await registry.list()).toHaveLength(0);
  });

  it("throws on update of nonexistent webhook", async () => {
    await expect(registry.update("nonexistent", { name: "Nope" })).rejects.toThrow();
  });

  it("throws on delete of nonexistent webhook", async () => {
    await expect(registry.remove("nonexistent")).rejects.toThrow();
  });

  it("persists across instances", async () => {
    const path = join(dir, "webhooks.json");
    const r1 = new WebhookRegistry(path);
    await r1.create({ name: "Persist", url: "https://example.com/hook", events: [] });
    const r2 = new WebhookRegistry(path);
    const all = await r2.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Persist");
  });

  it("getById returns webhook or undefined", async () => {
    const wh = await registry.create({ name: "Find me", url: "https://example.com/hook", events: [] });
    expect(await registry.getById(wh.id)).toEqual(wh);
    expect(await registry.getById("nonexistent")).toBeUndefined();
  });
});
