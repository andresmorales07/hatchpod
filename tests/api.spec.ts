import { test, expect } from '@playwright/test';

test('healthz returns 200 without auth', async ({ request }) => {
  const res = await request.get('/healthz', {
    headers: {}, // Override default auth header
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(body).toHaveProperty('uptime');
  expect(body).toHaveProperty('sessions');
});

test('rejects unauthenticated requests', async ({ request }) => {
  const res = await request.get('/api/sessions', {
    headers: { Authorization: '' }, // Override default auth
  });
  expect(res.status()).toBe(401);
});

test('accepts authenticated requests', async ({ request }) => {
  const res = await request.get('/api/sessions');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
});

test('creates a session', async ({ request }) => {
  const res = await request.post('/api/sessions', {
    data: { prompt: 'Say hello' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body).toHaveProperty('id');
  expect(body).toHaveProperty('status');
});

test('lists sessions', async ({ request }) => {
  // Create a session first
  await request.post('/api/sessions', {
    data: { prompt: 'Test session' },
  });

  const res = await request.get('/api/sessions');
  expect(res.status()).toBe(200);
  const sessions = await res.json();
  expect(sessions.length).toBeGreaterThan(0);
});

test('gets session details', async ({ request }) => {
  const createRes = await request.post('/api/sessions', {
    data: { prompt: 'Detail test' },
  });
  const { id } = await createRes.json();

  const res = await request.get(`/api/sessions/${id}`);
  expect(res.status()).toBe(200);
  const session = await res.json();
  expect(session.id).toBe(id);
  expect(session).toHaveProperty('status');
  expect(session).toHaveProperty('source', 'api');
});

test('interrupts a session', async ({ request }) => {
  const createRes = await request.post('/api/sessions', {
    data: { prompt: 'Interrupt test' },
  });
  const { id } = await createRes.json();

  const res = await request.delete(`/api/sessions/${id}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('deleted');
});

test('returns 404 for unknown session', async ({ request }) => {
  // Use a valid UUID format so the route regex matches — tests the 404 from session lookup, not regex mismatch
  const res = await request.get('/api/sessions/00000000-0000-0000-0000-000000000000');
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toBe('session not found');
});

test('creates an idle session without prompt', async ({ request }) => {
  const res = await request.post('/api/sessions', {
    data: {},
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body).toHaveProperty('id');
  expect(body.status).toBe('idle');
});

test('rejects request with invalid JSON body', async ({ request }) => {
  // Use a Buffer so Playwright sends the raw bytes without JSON-encoding the string
  const res = await request.post('/api/sessions', {
    data: Buffer.from('not json{{{'),
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('invalid request body');
});

test('creates an idle session with empty prompt', async ({ request }) => {
  const res = await request.post('/api/sessions', {
    data: { prompt: '' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body).toHaveProperty('id');
  expect(body.status).toBe('idle');
});

test('rejects request with non-string prompt', async ({ request }) => {
  const res = await request.post('/api/sessions', {
    data: { prompt: 123 },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('prompt must be a string');
});

test('returns 404 for non-UUID session path', async ({ request }) => {
  const res = await request.get('/api/sessions/not-a-uuid');
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toBe('not found');
});

test('browse returns directories at root', async ({ request }) => {
  const res = await request.get('/api/browse');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('path', '');
  expect(body).toHaveProperty('dirs');
  expect(Array.isArray(body.dirs)).toBe(true);
});

test('browse rejects path traversal', async ({ request }) => {
  const res = await request.get('/api/browse?path=../../etc');
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('invalid path');
});

test('browse returns 404 for nonexistent path', async ({ request }) => {
  const res = await request.get('/api/browse?path=nonexistent-dir-abc123');
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toBe('directory not found');
});

test('browse requires auth', async ({ request }) => {
  const res = await request.get('/api/browse', {
    headers: { Authorization: '' },
  });
  expect(res.status()).toBe(401);
});

test('session respects cwd from request', async ({ request }) => {
  const res = await request.post('/api/sessions', {
    data: { prompt: 'pwd', cwd: '/home/hatchpod/workspace' },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  const detail = await request.get(`/api/sessions/${id}`);
  const session = await detail.json();
  expect(session.cwd).toBe('/home/hatchpod/workspace');
});

test('idle session has correct status and fields', async ({ request }) => {
  const createRes = await request.post('/api/sessions', {
    data: { cwd: '/home/hatchpod/workspace' },
  });
  const { id } = await createRes.json();

  const res = await request.get(`/api/sessions/${id}`);
  expect(res.status()).toBe(200);
  const session = await res.json();
  expect(session.status).toBe('idle');
  expect(session.source).toBe('api');
  expect(session.lastError).toBeNull();
  expect(session.pendingApproval).toBeNull();
  expect(session.cwd).toBe('/home/hatchpod/workspace');
});
