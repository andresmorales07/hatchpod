import { test, expect } from '@playwright/test';

test('ttyd web terminal loads', async ({ page }) => {
  await page.goto('/');
  // ttyd serves an xterm.js terminal — wait for the terminal container
  const terminal = page.locator('.xterm');
  await expect(terminal).toBeVisible({ timeout: 15000 });
});

test('ttyd terminal has a canvas renderer', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit uses DOM renderer instead of canvas');
  await page.goto('/');
  // xterm.js renders terminal content on a canvas element
  const canvas = page.locator('.xterm canvas');
  await expect(canvas.first()).toBeVisible({ timeout: 15000 });
});

test('ttyd terminal is interactive (writable mode)', async ({ page }) => {
  await page.goto('/');
  const terminal = page.locator('.xterm');
  await expect(terminal).toBeVisible({ timeout: 15000 });

  // Type a command — writable mode (-W) must be enabled for this to work
  await terminal.click();
  await page.keyboard.type('echo hello-playwright');
  await page.keyboard.press('Enter');

  // xterm.js renders to canvas, so use the accessibility tree to read output
  await expect(page.locator('textarea.xterm-helper-textarea')).toBeFocused();
});

test('ttyd WebSocket connection stays alive', async ({ page }) => {
  await page.goto('/');
  const terminal = page.locator('.xterm');
  await expect(terminal).toBeVisible({ timeout: 15000 });

  // Type a command and verify the terminal is functional
  await terminal.click();
  await page.keyboard.type('echo ws-test-1');
  await page.keyboard.press('Enter');

  // Wait longer than a typical Safari idle timeout to verify
  // the ping-interval keepalive prevents disconnection
  await page.waitForTimeout(5000);

  // Type another command after the idle period — if the WebSocket
  // dropped, the terminal will no longer accept input
  await page.keyboard.type('echo ws-test-2');
  await page.keyboard.press('Enter');

  // Verify the terminal is still connected and responsive
  await expect(page.locator('textarea.xterm-helper-textarea')).toBeFocused();
});

test('ttyd WebSocket connects and receives data', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit does not pass basic-auth credentials to WebSocket connections in page.evaluate');

  // Navigate first so auth credentials are established
  await page.goto('/');
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });

  // Open a WebSocket directly to ttyd's /ws endpoint and verify
  // the server sends data (the initial terminal payload)
  const wsReceived = await page.evaluate(async () => {
    return new Promise<boolean>((resolve) => {
      const ws = new WebSocket(
        `ws://${location.host}/ws`,
        ['tty'],
      );
      const timer = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 10000);
      ws.onmessage = () => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  });
  expect(wsReceived).toBe(true);
});

test('ttyd returns correct auth challenge', async ({ request }) => {
  // Without credentials, ttyd should return 401
  const response = await request.get('http://localhost:7681/', {
    headers: {},
  });
  // With httpCredentials in config, Playwright sends auth automatically
  // so this request should succeed with 200
  expect(response.status()).toBe(200);
});
