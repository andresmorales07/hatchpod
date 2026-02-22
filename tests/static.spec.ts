import { test, expect } from '@playwright/test';

test('serves index.html at root', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'];
  expect(contentType).toContain('text/html');
});

test('blocks directory traversal with ..', async ({ request }) => {
  const res = await request.get('/../../etc/passwd');
  // Should either 404 or serve index.html (SPA fallback), never the actual file
  const body = await res.text();
  expect(body).not.toContain('root:');
});

test('blocks encoded directory traversal', async ({ request }) => {
  const res = await request.get('/%2e%2e/%2e%2e/etc/passwd');
  const body = await res.text();
  expect(body).not.toContain('root:');
});

test('returns 404 for nonexistent static files', async ({ request }) => {
  const res = await request.get('/nonexistent-file.js');
  expect(res.status()).toBe(404);
});

test('SPA fallback serves index.html for unknown paths without extension', async ({ request }) => {
  const res = await request.get('/some/deep/path');
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'];
  expect(contentType).toContain('text/html');
});

test('serves PWA manifest', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest.name).toBe('Hatchpod');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons).toBeDefined();
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test('serves PWA service worker', async ({ request }) => {
  const res = await request.get('/sw.js');
  expect(res.ok()).toBeTruthy();
  const contentType = res.headers()['content-type'];
  expect(contentType).toContain('javascript');
});

test('serves app icons', async ({ request }) => {
  const res192 = await request.get('/icons/icon-192.png');
  expect(res192.ok()).toBeTruthy();
  expect(res192.headers()['content-type']).toContain('image/png');

  const res512 = await request.get('/icons/icon-512.png');
  expect(res512.ok()).toBeTruthy();
  expect(res512.headers()['content-type']).toContain('image/png');
});
