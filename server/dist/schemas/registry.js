import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { SERVER_VERSION } from "../version.js";
import { ErrorResponseSchema } from "./common.js";
import { HealthResponseSchema } from "./health.js";
import { ConfigResponseSchema, ProviderInfoSchema } from "./config.js";
import { BrowseResponseSchema } from "./browse.js";
import { GitDiffStatSchema } from "./git.js";
import { NormalizedMessageSchema, PaginatedMessagesSchema, SessionListItemSchema, } from "./providers.js";
import { CreateSessionRequestSchema, CreateSessionResponseSchema, DeleteSessionResponseSchema, SessionDetailResponseSchema, SessionSummaryDTOSchema, } from "./sessions.js";
const registry = new OpenAPIRegistry();
// ── Security scheme ──
const bearerAuth = registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "API password passed as a Bearer token (set via API_PASSWORD env var)",
});
// ── Paths ──
registry.registerPath({
    method: "get",
    path: "/healthz",
    summary: "Health check",
    description: "Returns server uptime and session counts. No authentication required.",
    tags: ["Health"],
    responses: {
        200: {
            description: "Server is healthy",
            content: { "application/json": { schema: HealthResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "get",
    path: "/api/config",
    summary: "Server configuration",
    description: "Returns browseRoot and defaultCwd for the UI.",
    tags: ["Config"],
    security: [{ [bearerAuth.name]: [] }],
    responses: {
        200: {
            description: "Server configuration",
            content: { "application/json": { schema: ConfigResponseSchema } },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "get",
    path: "/api/providers",
    summary: "List providers",
    description: "Returns registered provider adapters (e.g. claude, test).",
    tags: ["Config"],
    security: [{ [bearerAuth.name]: [] }],
    responses: {
        200: {
            description: "List of providers",
            content: { "application/json": { schema: z.array(ProviderInfoSchema) } },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "post",
    path: "/api/sessions",
    summary: "Create session",
    description: "Creates a new Claude Code session. Omit `prompt` to create an idle session " +
        "that waits for a prompt via WebSocket.",
    tags: ["Sessions"],
    security: [{ [bearerAuth.name]: [] }],
    request: {
        body: {
            content: { "application/json": { schema: CreateSessionRequestSchema } },
        },
    },
    responses: {
        201: {
            description: "Session created",
            content: { "application/json": { schema: CreateSessionResponseSchema } },
        },
        400: {
            description: "Validation error",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        403: {
            description: "bypassPermissions is disabled",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        409: {
            description: "Maximum session limit reached",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "get",
    path: "/api/sessions",
    summary: "List sessions",
    description: "Returns active API sessions merged with historical CLI sessions. " +
        "Optionally filter by `?cwd=` to show only sessions from a specific workspace.",
    tags: ["Sessions"],
    security: [{ [bearerAuth.name]: [] }],
    request: {
        query: z.object({
            cwd: z.string().optional().openapi({ description: "Filter by working directory" }),
        }),
    },
    responses: {
        200: {
            description: "Array of session summaries. Active API sessions return `SessionSummaryDTO` " +
                "(with status, cost, turns); historical CLI sessions return `SessionListItem` " +
                "(with slug, summary). The two are merged and sorted by lastModified.",
            content: {
                "application/json": {
                    schema: z.union([
                        z.array(SessionSummaryDTOSchema),
                        z.array(SessionListItemSchema),
                    ]),
                },
            },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "get",
    path: "/api/sessions/{id}",
    summary: "Get session details",
    description: "Returns details for an active API session by ID.",
    tags: ["Sessions"],
    security: [{ [bearerAuth.name]: [] }],
    request: {
        params: z.object({
            id: z.string().uuid().openapi({ description: "Session UUID" }),
        }),
    },
    responses: {
        200: {
            description: "Session details",
            content: { "application/json": { schema: SessionDetailResponseSchema } },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        404: {
            description: "Session not found",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "delete",
    path: "/api/sessions/{id}",
    summary: "Delete session",
    description: "Interrupts a running session (if active) and removes it.",
    tags: ["Sessions"],
    security: [{ [bearerAuth.name]: [] }],
    request: {
        params: z.object({
            id: z.string().uuid().openapi({ description: "Session UUID" }),
        }),
    },
    responses: {
        200: {
            description: "Session deleted",
            content: { "application/json": { schema: DeleteSessionResponseSchema } },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        404: {
            description: "Session not found",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "get",
    path: "/api/sessions/{id}/history",
    summary: "Session message history",
    description: "Returns all normalized messages for a session from the provider's on-disk JSONL log. " +
        "Unlike `/messages` (which supports pagination), this endpoint returns the complete history in one response.",
    tags: ["Sessions"],
    security: [{ [bearerAuth.name]: [] }],
    request: {
        params: z.object({
            id: z.string().uuid().openapi({ description: "Session UUID" }),
        }),
        query: z.object({
            provider: z.string().optional().openapi({ description: "Provider ID (defaults to 'claude')" }),
        }),
    },
    responses: {
        200: {
            description: "Array of normalized messages",
            content: { "application/json": { schema: z.array(NormalizedMessageSchema) } },
        },
        400: {
            description: "Invalid session ID or unknown provider",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        404: {
            description: "Session history not found",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "get",
    path: "/api/sessions/{id}/messages",
    summary: "Paginated session messages",
    description: "Returns paginated messages for scroll-back loading. " +
        "Use `?before=N&limit=M` to page backwards through the message history.",
    tags: ["Sessions"],
    security: [{ [bearerAuth.name]: [] }],
    request: {
        params: z.object({
            id: z.string().uuid().openapi({ description: "Session UUID" }),
        }),
        query: z.object({
            provider: z.string().optional().openapi({ description: "Provider ID (defaults to 'claude')" }),
            before: z.coerce.number().int().optional().openapi({ description: "Return messages before this index" }),
            limit: z.coerce.number().int().optional().openapi({ description: "Max messages to return (default 30, max 100)" }),
        }),
    },
    responses: {
        200: {
            description: "Paginated messages with tasks",
            content: { "application/json": { schema: PaginatedMessagesSchema } },
        },
        400: {
            description: "Invalid parameters",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        404: {
            description: "Session not found",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "get",
    path: "/api/browse",
    summary: "Browse directories",
    description: "Lists subdirectories under the given path (relative to BROWSE_ROOT). " +
        "Used by the folder picker UI. Hidden directories and node_modules are excluded.",
    tags: ["Browse"],
    security: [{ [bearerAuth.name]: [] }],
    request: {
        query: z.object({
            path: z.string().optional().openapi({ description: "Relative path under BROWSE_ROOT (defaults to root)" }),
        }),
    },
    responses: {
        200: {
            description: "Directory listing",
            content: { "application/json": { schema: BrowseResponseSchema } },
        },
        400: {
            description: "Invalid path (traversal attempt)",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        403: {
            description: "Permission denied",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        404: {
            description: "Directory not found",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
registry.registerPath({
    method: "get",
    path: "/api/git/status",
    summary: "Git diff status",
    description: "Returns a compact summary of all uncommitted git changes (staged, unstaged, untracked) " +
        "in the given directory. Returns 404 if the directory is not a git repository.",
    tags: ["Git"],
    security: [{ [bearerAuth.name]: [] }],
    request: {
        query: z.object({
            cwd: z.string().openapi({ description: "Absolute path to the working directory" }),
        }),
    },
    responses: {
        200: {
            description: "Git diff statistics",
            content: { "application/json": { schema: GitDiffStatSchema } },
        },
        400: {
            description: "Missing or invalid cwd",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        401: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
        404: {
            description: "Not a git repository",
            content: { "application/json": { schema: ErrorResponseSchema } },
        },
    },
});
// ── Generate spec ──
const generator = new OpenApiGeneratorV31(registry.definitions);
export const openApiDocument = generator.generateDocument({
    openapi: "3.1.0",
    info: {
        title: "Hatchpod API",
        version: SERVER_VERSION,
        description: "REST API for managing Claude Code sessions, browsing the workspace, " +
            "and monitoring server health.\n\n" +
            "## WebSocket Protocol\n\n" +
            "Real-time session interaction uses WebSocket connections at " +
            "`/api/sessions/{id}/stream`. The first message must be an auth payload: " +
            '`{"type":"auth","token":"<API_PASSWORD>"}`. Subsequent messages follow ' +
            "the `ClientMessage` / `ServerMessage` protocol (see source types).\n\n" +
            "OpenAPI 3.1 does not natively support WebSocket documentation, so the " +
            "WS endpoint is described here rather than as a path.",
    },
    servers: [{ url: "/" }],
});
