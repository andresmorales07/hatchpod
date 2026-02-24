/**
 * Session message delivery integration tests.
 *
 * These tests exercise the SessionWatcher message delivery pipeline end-to-end
 * using the deterministic test provider. They verify:
 * - Push-mode message flow (user prompt + assistant messages arrive via WS)
 * - Session lifecycle status transitions
 * - Follow-up messages on completed sessions
 * - Reconnect replay from in-memory messages
 * - Multiple WS clients receiving the same broadcast
 * - Session ID remap (temp → provider ID)
 * - Interrupt via WS
 * - Multi-turn message sequences
 * - Tool approval flow
 * - Thinking deltas
 * - Slash commands (ephemeral, not stored in messages)
 *
 * Requires ENABLE_TEST_PROVIDER=1 on the API server.
 */
import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

const API_PORT = process.env.API_PORT || '8080';
const BASE_URL = process.env.BASE_URL || `http://localhost:${API_PORT}`;
const API_PASSWORD = process.env.API_PASSWORD || 'changeme';

// ── Helpers ──

function wsUrl(sessionId: string): string {
  const url = new URL(BASE_URL);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/api/sessions/${sessionId}/stream`;
}

interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

/**
 * Create a session using the test provider.
 * Returns the session ID.
 */
async function createTestSession(prompt: string, extra?: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_PASSWORD}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, provider: 'test', ...extra }),
  });
  expect(res.ok).toBe(true);
  const body = await res.json();
  return body.id;
}

/**
 * Open a WebSocket, authenticate, and return a connected socket plus
 * a persistent message collector.
 */
function connectWs(sessionId: string): Promise<{
  ws: WebSocket;
  messages: ServerMsg[];
  waitFor: (predicate: (msgs: ServerMsg[]) => boolean, timeoutMs?: number) => Promise<ServerMsg[]>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const messages: ServerMsg[] = [];
    const socket = new WebSocket(wsUrl(sessionId));

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'auth', token: API_PASSWORD }));
    });

    socket.on('message', (data) => {
      const msg: ServerMsg = JSON.parse(data.toString());
      messages.push(msg);
    });

    // Resolve after first message (auth accepted) or reject on error
    socket.once('message', (data) => {
      const msg: ServerMsg = JSON.parse(data.toString());
      if (msg.type === 'error' && msg.message === 'unauthorized') {
        reject(new Error('Auth failed'));
        return;
      }
      resolve({
        ws: socket,
        messages,
        waitFor: (predicate, timeoutMs = 10_000) => {
          return new Promise<ServerMsg[]>((res, rej) => {
            if (predicate(messages)) { res(messages); return; }
            const check = setInterval(() => {
              if (predicate(messages)) {
                clearInterval(check);
                clearTimeout(timer);
                res(messages);
              }
            }, 50);
            const timer = setTimeout(() => {
              clearInterval(check);
              rej(new Error(`waitFor timed out. Messages: ${JSON.stringify(messages.map(m => m.type))}`));
            }, timeoutMs);
            // Clean up if socket closes
            socket.once('close', () => { clearInterval(check); clearTimeout(timer); });
          });
        },
        close: () => socket.close(),
      });
    });

    socket.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 10_000);
  });
}

/** Extract messages of type "message" with a given role. */
function messagesOfRole(msgs: ServerMsg[], role: string): ServerMsg[] {
  return msgs.filter(
    (m) => m.type === 'message' && (m.message as { role: string })?.role === role,
  );
}

/** Check if messages include a status event with the given status value. */
function hasStatus(msgs: ServerMsg[], status: string): boolean {
  return msgs.some((m) => m.type === 'status' && m.status === status);
}

// ── Tests ──

test.describe('session delivery pipeline', () => {
  test('creates session and delivers user prompt + assistant echo', async () => {
    const sessionId = await createTestSession('Hello world');
    const conn = await connectWs(sessionId);

    try {
      // Wait for session to complete
      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      // Should have received the user prompt (pushed by runSession before generator)
      const userMsgs = messagesOfRole(conn.messages, 'user');
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
      const userParts = (userMsgs[0].message as { parts: Array<{ text?: string }> }).parts;
      expect(userParts[0].text).toBe('Hello world');

      // Should have received the assistant echo
      const assistantMsgs = messagesOfRole(conn.messages, 'assistant');
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
      const assistantParts = (assistantMsgs[0].message as { parts: Array<{ text?: string }> }).parts;
      expect(assistantParts[0].text).toBe('Echo: Hello world');

      // replay_complete should be present
      expect(conn.messages.some((m) => m.type === 'replay_complete')).toBe(true);
    } finally {
      conn.close();
    }
  });

  test('session lifecycle: starting → running → completed', async () => {
    const sessionId = await createTestSession('[slow] counting');
    const conn = await connectWs(sessionId);

    try {
      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      const statuses = conn.messages
        .filter((m) => m.type === 'status')
        .map((m) => m.status as string);

      // Must include running and completed (starting may be missed if fast)
      expect(statuses).toContain('running');
      expect(statuses).toContain('completed');
    } finally {
      conn.close();
    }
  });

  test('follow-up message on completed session', async () => {
    const sessionId = await createTestSession('First message');
    const conn = await connectWs(sessionId);

    try {
      // Wait for first run to complete
      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      const countBefore = conn.messages.filter((m) => m.type === 'message').length;

      // Send follow-up
      conn.ws.send(JSON.stringify({ type: 'prompt', text: 'Follow-up message' }));

      // Wait for second run to complete (a second 'completed' status)
      await conn.waitFor((msgs) => {
        const completedCount = msgs.filter(
          (m) => m.type === 'status' && m.status === 'completed',
        ).length;
        return completedCount >= 2;
      });

      // Should have new messages after the follow-up
      const allMsgEvents = conn.messages.filter((m) => m.type === 'message');
      expect(allMsgEvents.length).toBeGreaterThan(countBefore);

      // The follow-up user prompt should appear
      const userMsgs = messagesOfRole(conn.messages, 'user');
      const followUpUser = userMsgs.find((m) => {
        const parts = (m.message as { parts: Array<{ text?: string }> }).parts;
        return parts[0].text === 'Follow-up message';
      });
      expect(followUpUser).toBeDefined();

      // The follow-up echo should appear
      const assistantMsgs = messagesOfRole(conn.messages, 'assistant');
      const followUpEcho = assistantMsgs.find((m) => {
        const parts = (m.message as { parts: Array<{ text?: string }> }).parts;
        return parts[0].text === 'Echo: Follow-up message';
      });
      expect(followUpEcho).toBeDefined();
    } finally {
      conn.close();
    }
  });

  test('reconnect replays from in-memory messages', async () => {
    const sessionId = await createTestSession('Remember me');
    const conn1 = await connectWs(sessionId);

    try {
      await conn1.waitFor((msgs) => hasStatus(msgs, 'completed'));
    } finally {
      conn1.close();
    }

    // Wait briefly for close to propagate
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect — should get in-memory replay
    const conn2 = await connectWs(sessionId);
    try {
      await conn2.waitFor((msgs) => msgs.some((m) => m.type === 'replay_complete'));

      const userMsgs = messagesOfRole(conn2.messages, 'user');
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
      const parts = (userMsgs[0].message as { parts: Array<{ text?: string }> }).parts;
      expect(parts[0].text).toBe('Remember me');

      const assistantMsgs = messagesOfRole(conn2.messages, 'assistant');
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    } finally {
      conn2.close();
    }
  });

  test('multiple clients receive same broadcast', async () => {
    // Create idle session first, then connect two clients before sending prompt
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_PASSWORD}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'test' }),
    });
    const { id: sessionId } = await res.json();

    const conn1 = await connectWs(sessionId);
    const conn2 = await connectWs(sessionId);

    try {
      // Wait for both to get replay_complete
      await conn1.waitFor((msgs) => msgs.some((m) => m.type === 'replay_complete'));
      await conn2.waitFor((msgs) => msgs.some((m) => m.type === 'replay_complete'));

      // Send prompt via WS
      conn1.ws.send(JSON.stringify({ type: 'prompt', text: 'Broadcast test' }));

      // Both should receive the completed status
      await conn1.waitFor((msgs) => hasStatus(msgs, 'completed'));
      await conn2.waitFor((msgs) => hasStatus(msgs, 'completed'));

      // Both should have the echo message
      for (const conn of [conn1, conn2]) {
        const assistantMsgs = messagesOfRole(conn.messages, 'assistant');
        const echo = assistantMsgs.find((m) => {
          const parts = (m.message as { parts: Array<{ text?: string }> }).parts;
          return parts[0].text === 'Echo: Broadcast test';
        });
        expect(echo).toBeDefined();
      }
    } finally {
      conn1.close();
      conn2.close();
    }
  });

  test('session ID remap broadcasts session_redirected', async () => {
    // Use idle session so WS is connected before the remap happens
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_PASSWORD}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'test' }),
    });
    const { id: sessionId } = await res.json();

    const conn = await connectWs(sessionId);

    try {
      await conn.waitFor((msgs) => msgs.some((m) => m.type === 'replay_complete'));

      // Send remap scenario — provider returns a different providerSessionId
      conn.ws.send(JSON.stringify({ type: 'prompt', text: '[remap] test remap' }));

      await conn.waitFor(
        (msgs) => msgs.some((m) => m.type === 'session_redirected'),
      );

      const redirect = conn.messages.find((m) => m.type === 'session_redirected');
      expect(redirect).toBeDefined();
      expect(typeof redirect!.newSessionId).toBe('string');
      expect(redirect!.newSessionId).not.toBe(sessionId);
    } finally {
      conn.close();
    }
  });

  test('interrupt stops a slow session', async () => {
    const sessionId = await createTestSession('[slow] long running task');
    const conn = await connectWs(sessionId);

    try {
      // Wait for running status, then interrupt
      await conn.waitFor((msgs) => hasStatus(msgs, 'running'));
      conn.ws.send(JSON.stringify({ type: 'interrupt' }));

      // Should receive interrupted status
      await conn.waitFor((msgs) => hasStatus(msgs, 'interrupted'));

      const statuses = conn.messages
        .filter((m) => m.type === 'status')
        .map((m) => m.status as string);
      expect(statuses).toContain('interrupted');
    } finally {
      conn.close();
    }
  });

  test('multi-turn sequence delivers all messages in order', async () => {
    const sessionId = await createTestSession('[multi-turn] go');
    const conn = await connectWs(sessionId);

    try {
      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      const msgEvents = conn.messages
        .filter((m) => m.type === 'message')
        .map((m) => {
          const msg = m.message as { role: string; index: number; parts: Array<{ type: string; text?: string }> };
          return { role: msg.role, index: msg.index, firstPartType: msg.parts[0].type };
        });

      // Should have: user prompt, assistant text, assistant tool_use,
      // user tool_result, assistant text (4 from provider + 1 user prompt)
      expect(msgEvents.length).toBeGreaterThanOrEqual(5);

      // Indices should be monotonically increasing
      for (let i = 1; i < msgEvents.length; i++) {
        expect(msgEvents[i].index).toBeGreaterThan(msgEvents[i - 1].index);
      }
    } finally {
      conn.close();
    }
  });

  test('tool approval flow delivers approval request and result', async () => {
    const sessionId = await createTestSession('[tool-approval] run tool');
    const conn = await connectWs(sessionId);

    try {
      // Wait for tool_approval_request
      await conn.waitFor(
        (msgs) => msgs.some((m) => m.type === 'tool_approval_request'),
      );

      const approvalReq = conn.messages.find((m) => m.type === 'tool_approval_request');
      expect(approvalReq).toBeDefined();
      expect(approvalReq!.toolName).toBe('test_tool');
      expect(typeof approvalReq!.toolUseId).toBe('string');

      // Approve it
      conn.ws.send(JSON.stringify({
        type: 'approve',
        toolUseId: approvalReq!.toolUseId,
      }));

      // Wait for session to complete
      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      // Should have the "Tool was approved" message
      const assistantMsgs = messagesOfRole(conn.messages, 'assistant');
      const approved = assistantMsgs.find((m) => {
        const parts = (m.message as { parts: Array<{ text?: string }> }).parts;
        return parts[0].text === 'Tool was approved and executed.';
      });
      expect(approved).toBeDefined();
    } finally {
      conn.close();
    }
  });

  test('tool denial flow delivers denied message', async () => {
    const sessionId = await createTestSession('[tool-approval] run tool');
    const conn = await connectWs(sessionId);

    try {
      await conn.waitFor(
        (msgs) => msgs.some((m) => m.type === 'tool_approval_request'),
      );

      const approvalReq = conn.messages.find((m) => m.type === 'tool_approval_request');

      // Deny it
      conn.ws.send(JSON.stringify({
        type: 'deny',
        toolUseId: approvalReq!.toolUseId,
        message: 'Not allowed',
      }));

      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      const assistantMsgs = messagesOfRole(conn.messages, 'assistant');
      const denied = assistantMsgs.find((m) => {
        const parts = (m.message as { parts: Array<{ text?: string }> }).parts;
        return parts[0].text === 'Tool was denied.';
      });
      expect(denied).toBeDefined();
    } finally {
      conn.close();
    }
  });

  test('thinking deltas stream before final message', async () => {
    const sessionId = await createTestSession('[thinking] deep thought');
    const conn = await connectWs(sessionId);

    try {
      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      // Should have received thinking_delta events
      const thinkingDeltas = conn.messages.filter((m) => m.type === 'thinking_delta');
      expect(thinkingDeltas.length).toBeGreaterThan(0);

      // Concatenated thinking text
      const fullThinking = thinkingDeltas.map((m) => m.text).join('');
      expect(fullThinking).toContain('analyze this');

      // Should also have the final assistant message with reasoning part
      const assistantMsgs = messagesOfRole(conn.messages, 'assistant');
      const withReasoning = assistantMsgs.find((m) => {
        const parts = (m.message as { parts: Array<{ type: string }> }).parts;
        return parts.some((p) => p.type === 'reasoning');
      });
      expect(withReasoning).toBeDefined();
    } finally {
      conn.close();
    }
  });

  test('slash commands delivered as ephemeral event', async () => {
    // Use idle session so WS is connected before the ephemeral event fires
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_PASSWORD}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'test' }),
    });
    const { id: sessionId } = await res.json();

    const conn = await connectWs(sessionId);

    try {
      await conn.waitFor((msgs) => msgs.some((m) => m.type === 'replay_complete'));

      // Send slash-commands scenario via WS prompt
      conn.ws.send(JSON.stringify({ type: 'prompt', text: '[slash-commands] hello' }));

      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      // Should have received slash_commands event
      const slashCmd = conn.messages.find((m) => m.type === 'slash_commands');
      expect(slashCmd).toBeDefined();
      const commands = slashCmd!.commands as Array<{ name: string }>;
      expect(commands.length).toBe(2);
      expect(commands[0].name).toBe('/test');

      // Slash commands are ephemeral — system_init messages are NOT stored as messages
      const systemMsgs = messagesOfRole(conn.messages, 'system');
      expect(systemMsgs.length).toBe(0);
    } finally {
      conn.close();
    }
  });

  test('message indices are sequential across session lifetime', async () => {
    const sessionId = await createTestSession('[multi-turn] sequence');
    const conn = await connectWs(sessionId);

    try {
      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      const indices = conn.messages
        .filter((m) => m.type === 'message')
        .map((m) => (m.message as { index: number }).index);

      // Indices should start at 0 and be strictly increasing
      expect(indices[0]).toBe(0);
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBe(indices[i - 1] + 1);
      }
    } finally {
      conn.close();
    }
  });

  test('message indices remain contiguous across follow-up', async () => {
    const sessionId = await createTestSession('First turn');
    const conn = await connectWs(sessionId);

    try {
      // Wait for first run to complete
      await conn.waitFor((msgs) => hasStatus(msgs, 'completed'));

      // Collect indices from first run
      const firstRunIndices = conn.messages
        .filter((m) => m.type === 'message')
        .map((m) => (m.message as { index: number }).index);

      expect(firstRunIndices.length).toBeGreaterThanOrEqual(2);
      expect(firstRunIndices[0]).toBe(0);

      // Send follow-up
      conn.ws.send(JSON.stringify({ type: 'prompt', text: 'Second turn' }));

      // Wait for second completion
      await conn.waitFor((msgs) => {
        const completedCount = msgs.filter(
          (m) => m.type === 'status' && m.status === 'completed',
        ).length;
        return completedCount >= 2;
      });

      // Collect ALL indices across both runs
      const allIndices = conn.messages
        .filter((m) => m.type === 'message')
        .map((m) => (m.message as { index: number }).index);

      // Indices must be strictly contiguous: 0, 1, 2, 3, ...
      for (let i = 0; i < allIndices.length; i++) {
        expect(allIndices[i]).toBe(i);
      }

      // Second run should have added at least 2 messages (user prompt + echo)
      expect(allIndices.length).toBeGreaterThan(firstRunIndices.length);
    } finally {
      conn.close();
    }
  });

  test('error scenario delivers error status', async () => {
    const sessionId = await createTestSession('[error] crash test');
    const conn = await connectWs(sessionId);

    try {
      await conn.waitFor((msgs) => hasStatus(msgs, 'error'));

      const errorStatus = conn.messages.find(
        (m) => m.type === 'status' && m.status === 'error',
      );
      expect(errorStatus).toBeDefined();
    } finally {
      conn.close();
    }
  });
});
