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
  expect(session).toHaveProperty('messages');
  expect(session).toHaveProperty('status');
});

test('interrupts a session', async ({ request }) => {
  const createRes = await request.post('/api/sessions', {
    data: { prompt: 'Interrupt test' },
  });
  const { id } = await createRes.json();

  const res = await request.delete(`/api/sessions/${id}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('interrupted');
});

test('returns 404 for unknown session', async ({ request }) => {
  // Use a valid UUID format so the route regex matches — tests the 404 from session lookup, not regex mismatch
  const res = await request.get('/api/sessions/00000000-0000-0000-0000-000000000000');
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toBe('session not found');
});

test('rejects request with missing prompt', async ({ request }) => {
  const res = await request.post('/api/sessions', {
    data: {},
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('prompt is required');
});

test('rejects request with invalid JSON body', async ({ request }) => {
  // Use fetch directly to send a raw string body that Playwright won't auto-serialize
  const res = await fetch('http://localhost:8080/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.API_PASSWORD || 'changeme'}`,
    },
    body: 'not json{{{',
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('invalid request body');
});

test('rejects request with empty prompt', async ({ request }) => {
  const res = await request.post('/api/sessions', {
    data: { prompt: '' },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('prompt is required');
});

test('rejects request with non-string prompt', async ({ request }) => {
  const res = await request.post('/api/sessions', {
    data: { prompt: 123 },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('prompt is required');
});

test('returns 404 for non-UUID session path', async ({ request }) => {
  const res = await request.get('/api/sessions/not-a-uuid');
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toBe('not found');
});
