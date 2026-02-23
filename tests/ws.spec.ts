import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

const API_PORT = process.env.API_PORT || '8080';
const BASE_URL = process.env.BASE_URL || `http://localhost:${API_PORT}`;
const API_PASSWORD = process.env.API_PASSWORD || 'changeme';

function wsUrl(sessionId: string): string {
  const url = new URL(BASE_URL);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/api/sessions/${sessionId}/stream`;
}

async function createSession(prompt = 'Say hello'): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_PASSWORD}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt }),
  });
  const body = await res.json();
  return body.id;
}

function connectAndAuth(sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(sessionId));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: API_PASSWORD }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      // First non-error message after auth means we're connected
      if (msg.type !== 'error') {
        resolve(ws);
      } else {
        reject(new Error(`Auth failed: ${msg.message}`));
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 10000);
  });
}

test('rejects WebSocket without auth message', async () => {
  const sessionId = await createSession();

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    const ws = new WebSocket(wsUrl(sessionId));
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
    // Don't send auth — should timeout
  });

  const result = await closed;
  expect(result.code).toBe(4001);
});

test('rejects WebSocket with wrong token', async () => {
  const sessionId = await createSession();

  const closed = new Promise<{ code: number }>((resolve) => {
    const ws = new WebSocket(wsUrl(sessionId));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: 'wrong-password' }));
    });
    ws.on('close', (code) => {
      resolve({ code });
    });
  });

  const result = await closed;
  expect(result.code).toBe(4001);
});

test('authenticates and receives replay + status', async () => {
  const sessionId = await createSession();

  // Collect ALL messages from the start (don't use connectAndAuth which consumes messages)
  const messages: Array<{ type: string }> = [];

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl(sessionId));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: API_PASSWORD }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'error' && msg.message === 'unauthorized') {
        reject(new Error('Auth failed'));
        return;
      }
      messages.push(msg);
      // Resolve once we have both expected messages
      const types = messages.map((m) => m.type);
      if (types.includes('replay_complete') && types.includes('status')) {
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
    setTimeout(() => { ws.close(); resolve(); }, 5000);
  });

  const types = messages.map((m) => m.type);
  expect(types).toContain('replay_complete');
  expect(types).toContain('status');
});

test('nonexistent session receives replay_complete and status', async () => {
  const fakeId = '00000000-0000-0000-0000-000000000000';

  const messages: Array<{ type: string; status?: string; source?: string }> = [];

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(wsUrl(fakeId));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: API_PASSWORD }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);
      // Resolve once we have both expected messages
      const types = messages.map((m) => m.type);
      if (types.includes('replay_complete') && types.includes('status')) {
        ws.close();
        resolve();
      }
    });
    setTimeout(() => resolve(), 5000);
  });

  const types = messages.map((m) => m.type);
  expect(types).toContain('replay_complete');
  expect(types).toContain('status');
  // Nonexistent sessions are treated as CLI sessions (viewer mode)
  const statusMsg = messages.find((m) => m.type === 'status');
  expect(statusMsg?.source).toBe('cli');
});

test('receives replay_complete and status for active session', async () => {
  const sessionId = await createSession('What is 2+2?');

  // Collect ALL messages from the start (don't use connectAndAuth which consumes messages)
  const messages: Array<{ type: string; [key: string]: unknown }> = [];

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl(sessionId));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: API_PASSWORD }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'error' && msg.message === 'unauthorized') {
        reject(new Error('Auth failed'));
        return;
      }
      messages.push(msg);
      // Resolve once we have both expected messages
      const types = messages.map((m) => m.type);
      if (types.includes('replay_complete') && types.includes('status')) {
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
    setTimeout(() => { ws.close(); resolve(); }, 5000);
  });

  const types = messages.map((m) => m.type);
  expect(types).toContain('replay_complete');
  expect(types).toContain('status');
  // Active API session should report source as "api"
  const statusMsg = messages.find((m) => m.type === 'status');
  expect(statusMsg?.source).toBe('api');
});

test('interrupt via WebSocket', async () => {
  const sessionId = await createSession('Count to 1000 slowly');
  const ws = await connectAndAuth(sessionId);

  // Send interrupt
  ws.send(JSON.stringify({ type: 'interrupt' }));

  const statusMessages: Array<{ type: string; status?: string }> = [];
  await new Promise<void>((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'status') {
        statusMessages.push(msg);
        if (msg.status === 'interrupted') resolve();
      }
    });
    setTimeout(resolve, 10000);
  });

  ws.close();

  const statuses = statusMessages.map((m) => m.status);
  expect(statuses).toContain('interrupted');
});

test('handles invalid JSON gracefully', async () => {
  const sessionId = await createSession();
  const ws = await connectAndAuth(sessionId);

  // Wait for initial replay to finish
  await new Promise((r) => setTimeout(r, 500));

  ws.send('not json{{{');

  const errorMsg = await new Promise<{ type: string; message: string }>((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'error' && msg.message === 'invalid JSON') {
        resolve(msg);
      }
    });
    setTimeout(() => resolve({ type: 'timeout', message: 'no error received' }), 3000);
  });

  ws.close();

  expect(errorMsg.type).toBe('error');
  expect(errorMsg.message).toBe('invalid JSON');
});
