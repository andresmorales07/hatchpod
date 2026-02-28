import { randomUUID } from "node:crypto";
import pty from "node-pty";
import type { IPty } from "node-pty";

const TTL_MS = 5 * 60 * 1000; // 5 minutes of inactivity before PTY is killed

// Cap the output ring buffer at 200 chunks or 64 KB total, whichever is smaller.
const MAX_BUFFER_CHUNKS = 200;
const MAX_BUFFER_BYTES = 64 * 1024;

interface PtySession {
  pty: IPty;
  /** Raw PTY output chunks for reconnect replay. */
  outputBuffer: string[];
  /** Cleared when a client connects; restarted when the last client disconnects. */
  ttlTimer: ReturnType<typeof setTimeout>;
  /** Callbacks called with each chunk of PTY output. */
  onData: Set<(data: string) => void>;
  /** Callbacks called when the PTY process exits. */
  onExit: Set<(exitCode: number) => void>;
}

const sessions = new Map<string, PtySession>();

function startTTL(sessionId: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => destroyPtySession(sessionId), TTL_MS);
}

function addToBuffer(session: PtySession, chunk: string): void {
  session.outputBuffer.push(chunk);
  // Trim by chunk count
  while (session.outputBuffer.length > MAX_BUFFER_CHUNKS) {
    session.outputBuffer.shift();
  }
  // Trim by total byte size
  let total = session.outputBuffer.reduce((n, s) => n + s.length, 0);
  while (total > MAX_BUFFER_BYTES && session.outputBuffer.length > 0) {
    total -= session.outputBuffer[0]!.length;
    session.outputBuffer.shift();
  }
}

/** Create a new PTY session and return its session ID. */
export function createPtySession(shell: string, cwd: string): string {
  const sessionId = randomUUID();

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>,
  });

  const session: PtySession = {
    pty: ptyProcess,
    outputBuffer: [],
    ttlTimer: startTTL(sessionId),
    onData: new Set(),
    onExit: new Set(),
  };
  sessions.set(sessionId, session);

  ptyProcess.onData((data) => {
    addToBuffer(session, data);
    for (const cb of session.onData) cb(data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    const code = exitCode ?? 0;
    clearTimeout(session.ttlTimer);
    sessions.delete(sessionId);
    for (const cb of session.onExit) cb(code);
  });

  return sessionId;
}

/**
 * Attach a data listener to an existing PTY session.
 * Resets the inactivity TTL while a client is connected.
 * Returns the output buffer (for replay) and the session, or null if not found.
 */
export function attachPtySession(
  id: string,
  onData: (data: string) => void,
): { outputBuffer: string[] } | null {
  const session = sessions.get(id);
  if (!session) return null;

  clearTimeout(session.ttlTimer);
  session.onData.add(onData);
  return { outputBuffer: [...session.outputBuffer] };
}

/** Detach a data listener. Restarts the TTL when the last client disconnects. */
export function detachPtySession(id: string, onData: (data: string) => void): void {
  const session = sessions.get(id);
  if (!session) return;
  session.onData.delete(onData);
  if (session.onData.size === 0) {
    session.ttlTimer = startTTL(id);
  }
}

/** Register a callback for when the PTY process exits. Returns a cleanup function. */
export function onPtyExit(id: string, cb: (exitCode: number) => void): () => void {
  const session = sessions.get(id);
  if (!session) {
    // Session already gone — call cb immediately with exit code 0
    cb(0);
    return () => {};
  }
  session.onExit.add(cb);
  return () => session.onExit.delete(cb);
}

/** Write raw input to the PTY's stdin. Returns false if the session is not found. */
export function writeToPty(id: string, data: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.pty.write(data);
  return true;
}

/** Resize the PTY. Silently ignored if the session is not found. */
export function resizePty(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  session.pty.resize(cols, rows);
}

/** Immediately kill the PTY session (e.g. called from TTL or on server shutdown). */
export function destroyPtySession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  clearTimeout(session.ttlTimer);
  sessions.delete(id);
  try {
    session.pty.kill();
  } catch {
    // Already dead — ignore
  }
}

/** Returns the number of active PTY sessions. */
export function getPtySessionCount(): number {
  return sessions.size;
}
