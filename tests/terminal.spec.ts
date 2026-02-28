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
 *  Resolves with { ws, sessionId } once the shell has emitted its first output
 *  (i.e., the prompt is ready), so commands can be sent without any sleep.
 */
function attachTerminal(shell = '/bin/bash'): Promise<{ ws: WebSocket; sessionId: string; output: string[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(terminalWsUrl());
    const output: string[] = [];
    let sessionId = '';
    let isAttached = false;
    let resolved = false;

    const tryResolve = () => {
      if (!resolved && isAttached && output.length > 0) {
        resolved = true;
        resolve({ ws, sessionId, output });
      }
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: API_PASSWORD }));
      ws.send(JSON.stringify({ type: 'attach', shell }));
    });

    ws.on('message', (raw: Buffer | string) => {
      const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as Record<string, unknown>;
      switch (msg.type) {
        case 'attached':
          sessionId = msg.sessionId as string;
          isAttached = true;
          tryResolve();
          break;
        case 'output':
          output.push(msg.data as string);
          tryResolve();
          break;
        case 'error':
          if (!resolved) reject(new Error(`Terminal error: ${msg.message as string}`));
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
    const savedPush = output.push;
    const cleanup = () => { output.push = savedPush; };

    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${needle}" in terminal output. Got: ${output.join('')}`));
    }, timeoutMs);

    const check = () => {
      const full = output.join('');
      if (full.includes(needle)) {
        clearTimeout(deadline);
        cleanup();
        resolve(full);
      }
    };

    // Intercept new chunks so we can react without polling.
    // cleanup() restores the original push when the promise settles.
    output.push = function (...args: string[]) {
      const result = Array.prototype.push.apply(output, args);
      check();
      return result;
    };

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

  const full = await sendAndWait(ws, output, 'echo $PATH\n', '/usr/local/bin');
  ws.close();

  expect(full).toContain('/usr/local/bin');
});

test('terminal shell PATH includes npm global bin (login shell)', async () => {
  const { ws, output } = await attachTerminal();

  const full = await sendAndWait(ws, output, 'echo $PATH\n', '.npm-global/bin');
  ws.close();

  expect(full).toContain('.npm-global/bin');
});
