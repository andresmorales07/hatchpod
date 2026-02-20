import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, stopServer, resetSessions, api, connectWs, collectMessages, waitForStatus } from "./helpers.js";
import type { ServerMessage } from "../src/types.js";

beforeAll(async () => {
  await startServer();
  await resetSessions();
});

afterAll(async () => {
  await stopServer();
});

describe("Tool Approval", () => {
  it("receives approval request and approves", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[tool-approval] do it", provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);

    // Collect until we see tool_approval_request
    const messages = await collectMessages(ws, (msg) => msg.type === "tool_approval_request");
    const approvalReq = messages.find((m) => m.type === "tool_approval_request") as ServerMessage & {
      toolName: string;
      toolUseId: string;
    };
    expect(approvalReq).toBeDefined();
    expect(approvalReq.toolName).toBe("test_tool");

    // Approve via WS
    ws.send(JSON.stringify({ type: "approve", toolUseId: approvalReq.toolUseId }));

    // Collect remaining messages until completion
    const remaining = await collectMessages(ws, (msg) =>
      msg.type === "status" && (msg as ServerMessage & { status: string }).status === "completed",
    );

    // Should have message(s) with approval result
    const msgs = remaining.filter((m) => m.type === "message");
    expect(msgs.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  it("receives approval request and denies", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[tool-approval] deny me", provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);

    // Collect until approval request
    const messages = await collectMessages(ws, (msg) => msg.type === "tool_approval_request");
    const approvalReq = messages.find((m) => m.type === "tool_approval_request") as ServerMessage & {
      toolUseId: string;
    };

    // Deny
    ws.send(JSON.stringify({ type: "deny", toolUseId: approvalReq.toolUseId, message: "Not allowed" }));

    // Wait for completion
    const remaining = await collectMessages(ws, (msg) =>
      msg.type === "status" && (msg as ServerMessage & { status: string }).status === "completed",
    );

    // Check final message says "denied"
    const msgEvents = remaining.filter((m) => m.type === "message");
    const lastMsg = msgEvents[msgEvents.length - 1] as ServerMessage & {
      message: { parts: Array<{ type: string; text?: string }> };
    };
    expect(lastMsg).toBeDefined();
    const textPart = lastMsg.message.parts.find((p) => p.type === "text");
    expect(textPart?.text).toBe("Tool was denied.");

    ws.close();
  });

  it("shows pending approval in REST response", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[tool-approval] rest check", provider: "test" }),
    });
    const { id } = await createRes.json();

    // Wait for waiting_for_approval status
    const session = await waitForStatus(id, "waiting_for_approval") as {
      status: string;
      pendingApproval: { toolName: string; toolUseId: string } | null;
    };

    expect(session.status).toBe("waiting_for_approval");
    expect(session.pendingApproval).not.toBeNull();
    expect(session.pendingApproval!.toolName).toBe("test_tool");

    // Approve to let it complete (cleanup)
    const ws = await connectWs(id);
    // Drain replay
    await collectMessages(ws, (m) => m.type === "replay_complete");
    ws.send(JSON.stringify({ type: "approve", toolUseId: session.pendingApproval!.toolUseId }));
    await collectMessages(ws, (msg) =>
      msg.type === "status" && (msg as ServerMessage & { status: string }).status === "completed",
    );
    ws.close();
  });

  it("transitions status correctly during approval flow", async () => {
    const createRes = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt: "[tool-approval] status flow", provider: "test" }),
    });
    const { id } = await createRes.json();

    const ws = await connectWs(id);

    // Track all status transitions
    const statuses: string[] = [];
    const allMsgs = await collectMessages(ws, (msg) => msg.type === "tool_approval_request");

    for (const m of allMsgs) {
      if (m.type === "status") {
        statuses.push((m as ServerMessage & { status: string }).status);
      }
    }

    // Should see waiting_for_approval
    expect(statuses).toContain("waiting_for_approval");

    // Approve
    const approvalReq = allMsgs.find((m) => m.type === "tool_approval_request") as ServerMessage & {
      toolUseId: string;
    };
    ws.send(JSON.stringify({ type: "approve", toolUseId: approvalReq.toolUseId }));

    const remaining = await collectMessages(ws, (msg) =>
      msg.type === "status" && (msg as ServerMessage & { status: string }).status === "completed",
    );

    for (const m of remaining) {
      if (m.type === "status") {
        statuses.push((m as ServerMessage & { status: string }).status);
      }
    }

    // Should see running after approval, then completed
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");

    ws.close();
  });
});
