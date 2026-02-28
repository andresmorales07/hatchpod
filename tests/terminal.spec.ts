import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

const API_PORT = process.env.API_PORT || '8080';
const BASE_URL = `http://localhost:${API_PORT}`;
const API_PASSWORD = process.env.API_PASSWORD || 'changeme';

function terminalWsUrl(): string {
  const url = new URL(BASE_URL);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/api/terminal/stream`;
}

/** Connect to the terminal WebSocket, auth, and attach a fresh shell session.
 *  Resolves with { ws, sessionId } once the "attached" message arrives.
 *  Collects all output chunks into `output` until the promise resolves.
 */
function attachTerminal(shell = '/bin/bash'): Promise<{ ws: WebSocket; sessionId: string; output: string[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(terminalWsUrl());
    const output: string[] = [];
    let attached = false;
    let sessionId = '';

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: API_PASSWORD }));
      ws.send(JSON.stringify({ type: 'attach', shell }));
    });

    ws.on('message', (raw: Buffer | string) => {
      const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as Record<string, unknown>;
      switch (msg.type) {
        case 'attached':
          sessionId = msg.sessionId as string;
          attached = true;
          resolve({ ws, sessionId, output });
          break;
        case 'output':
          output.push(msg.data as string);
          break;
        case 'error':
          if (!attached) reject(new Error(`Terminal error: ${msg.message as string}`));
          break;
      }
    });

    ws.on('error', reject);
    setTimeout(() => reject(new Error('Terminal attach timed out after 10s')), 10_000);
  });
}

/** Send input to the PTY and wait until collected output includes `needle`. */
function sendAndWait(ws: WebSocket, output: string[], input: string, needle: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${needle}" in terminal output. Got: ${output.join('')}`));
    }, timeoutMs);

    // Flush already-collected output in case it arrived before this call
    const check = () => {
      const full = output.join('');
      if (full.includes(needle)) {
        clearTimeout(deadline);
        resolve(full);
      }
    };

    const origPush = output.push.bind(output);
    output.push = (...args: string[]) => {
      const result = origPush(...args);
      check();
      return result;
    };

    // Send the input
    ws.send(JSON.stringify({ type: 'input', data: input }));

    // Check immediately in case output is already buffered
    check();
  });
}

test('terminal WebSocket attaches and returns a session ID', async () => {
  const { ws, sessionId } = await attachTerminal();
  ws.close();

  expect(typeof sessionId).toBe('string');
  expect(sessionId.length).toBeGreaterThan(0);
});

test('terminal shell PATH includes /usr/local/bin (login shell)', async () => {
  const { ws, output } = await attachTerminal();

  // Wait briefly for the prompt to appear, then query PATH
  await new Promise((r) => setTimeout(r, 500));

  const full = await sendAndWait(ws, output, 'echo $PATH\n', '/usr/local/bin');
  ws.close();

  expect(full).toContain('/usr/local/bin');
});

test('terminal shell PATH includes npm global bin (login shell)', async () => {
  const { ws, output } = await attachTerminal();

  await new Promise((r) => setTimeout(r, 500));

  const full = await sendAndWait(ws, output, 'echo $PATH\n', '.npm-global/bin');
  ws.close();

  expect(full).toContain('.npm-global/bin');
});
