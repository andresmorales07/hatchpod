import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
extendZodWithOpenApi(z);

/** Valid webhook event types. */
export const WEBHOOK_EVENT_TYPES = [
  "session.created",
  "session.status",
  "message",
  "tool.approval",
  "subagent.started",
  "subagent.completed",
  "context.usage",
  "mode.changed",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const WebhookTemplateSchema = z.object({
  headers: z.record(z.string(), z.string()).optional().openapi({ description: "Custom HTTP headers" }),
  body: z.string().min(1).openapi({ description: "Template body with {{variable}} interpolation" }),
}).openapi("WebhookTemplate");

export const WebhookSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).openapi({ description: "Event filter. Empty array = all events." }),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  template: WebhookTemplateSchema.optional(),
}).openapi("Webhook");

export const CreateWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).default([]),
  enabled: z.boolean().default(true),
  template: WebhookTemplateSchema.optional(),
}).openapi("CreateWebhook");

export const PatchWebhookSchema = CreateWebhookSchema.partial().openapi("PatchWebhook");

export type Webhook = z.infer<typeof WebhookSchema>;
export type CreateWebhook = z.infer<typeof CreateWebhookSchema>;
export type PatchWebhook = z.infer<typeof PatchWebhookSchema>;
