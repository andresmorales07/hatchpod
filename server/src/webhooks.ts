import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { WebhookSchema, type Webhook, type CreateWebhook, type PatchWebhook } from "./schemas/webhooks.js";
import { z } from "zod";

const DEFAULT_PATH = join(homedir(), ".config", "hatchpod", "webhooks.json");

export class WebhookRegistry {
  private cache: Webhook[] | null = null;

  constructor(private readonly path: string = DEFAULT_PATH) {}

  async list(): Promise<Webhook[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = z.array(WebhookSchema).safeParse(JSON.parse(raw));
      this.cache = parsed.success ? parsed.data : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  async getById(id: string): Promise<Webhook | undefined> {
    const all = await this.list();
    return all.find((w) => w.id === id);
  }

  async create(input: CreateWebhook): Promise<Webhook> {
    const all = await this.list();
    const defaults = { enabled: true, events: [] as string[] };
    const webhook = WebhookSchema.parse({
      ...defaults,
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    all.push(webhook);
    await this.save(all);
    return webhook;
  }

  async update(id: string, patch: PatchWebhook): Promise<Webhook> {
    const all = await this.list();
    const idx = all.findIndex((w) => w.id === id);
    if (idx === -1) throw new Error(`Webhook ${id} not found`);
    const merged = WebhookSchema.parse({ ...all[idx], ...patch });
    all[idx] = merged;
    await this.save(all);
    return merged;
  }

  async remove(id: string): Promise<void> {
    const all = await this.list();
    const idx = all.findIndex((w) => w.id === id);
    if (idx === -1) throw new Error(`Webhook ${id} not found`);
    all.splice(idx, 1);
    await this.save(all);
  }

  private async save(webhooks: Webhook[]): Promise<void> {
    this.cache = null;
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(webhooks, null, 2));
    await rename(tmp, this.path);
    this.cache = webhooks;
  }
}
