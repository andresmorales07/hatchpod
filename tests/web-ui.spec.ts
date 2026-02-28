import { test, expect } from '@playwright/test';

const API_PASSWORD = process.env.API_PASSWORD || 'changeme';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/');
  const passwordInput = page.locator('input[type="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 10000 });
  await passwordInput.fill(API_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(passwordInput).not.toBeVisible({ timeout: 10000 });
}

test('login page loads', async ({ page }) => {
  await page.goto('/');
  // Hash router redirects to /#/login when not authenticated
  const passwordInput = page.locator('input[type="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 10000 });
  await expect(page.locator('button[type="submit"]')).toBeVisible();
  await expect(page.locator('text=Hatchpod')).toBeVisible();
  await expect(page.locator('text=Enter your API password to connect')).toBeVisible();
});

test('authenticates with correct password', async ({ page }) => {
  await page.goto('/');
  const passwordInput = page.locator('input[type="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 10000 });

  await passwordInput.fill(process.env.API_PASSWORD || 'changeme');
  await page.locator('button[type="submit"]').click();

  // After login, password input should disappear and search bar should appear
  await expect(passwordInput).not.toBeVisible({ timeout: 10000 });
  await expect(page.getByPlaceholder('Search sessions...')).toBeVisible({ timeout: 5000 });
});

test('rejects incorrect password', async ({ page }) => {
  await page.goto('/');
  const passwordInput = page.locator('input[type="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 10000 });

  await passwordInput.fill('wrong-password');
  await page.locator('button[type="submit"]').click();

  // Should show error and stay on login page
  await expect(page.getByText('Invalid password')).toBeVisible({ timeout: 5000 });
  await expect(passwordInput).toBeVisible();
});

test('navigates to new session page', async ({ page }) => {
  await page.goto('/');
  const passwordInput = page.locator('input[type="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 10000 });

  await passwordInput.fill(process.env.API_PASSWORD || 'changeme');
  await page.locator('button[type="submit"]').click();

  // Wait for auth to complete
  await expect(passwordInput).not.toBeVisible({ timeout: 10000 });

  // Click new session button
  await page.getByRole('button', { name: /New Session/ }).first().click();

  // Should navigate to new session page
  await expect(page.getByText('Working Directory')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Initial Prompt')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Session' })).toBeVisible();
});

test('persists auth across page reload', async ({ page }) => {
  await page.goto('/');
  const passwordInput = page.locator('input[type="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 10000 });

  await passwordInput.fill(process.env.API_PASSWORD || 'changeme');
  await page.locator('button[type="submit"]').click();

  // Wait for auth to complete — password input should disappear
  await expect(passwordInput).not.toBeVisible({ timeout: 10000 });

  // Reload the page
  await page.reload();

  // Should still be authenticated (password input should not appear, search bar should)
  await expect(page.locator('input[type="password"]')).not.toBeVisible({ timeout: 10000 });
  await expect(page.getByPlaceholder('Search sessions...')).toBeVisible({ timeout: 5000 });
});

// --- New tests ---

test('session creation navigates to chat page', async ({ page }) => {
  await login(page);

  // Mock POST /api/sessions to return a fake session without needing a real provider
  const fakeSessionId = '10000000-0000-0000-0000-000000000001';
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: fakeSessionId, status: 'idle', createdAt: new Date().toISOString() }),
      });
    } else {
      await route.continue();
    }
  });

  // Navigate to new session page
  await page.getByRole('button', { name: /New Session/ }).first().click();
  await expect(page.getByRole('button', { name: 'Create Session' })).toBeVisible({ timeout: 5000 });

  // Fill a prompt and click Create
  await page.getByPlaceholder('What would you like to work on?').fill('Hello, test!');
  await page.getByRole('button', { name: 'Create Session' }).click();

  // Should navigate to the chat page for the fake session
  await expect(page).toHaveURL(new RegExp(`/session/${fakeSessionId}`), { timeout: 5000 });

  // Composer should be visible on the chat page (may show viewer mode placeholder if WS reports CLI source)
  const composer = page.locator('textarea[placeholder]');
  await expect(composer).toBeVisible({ timeout: 5000 });
});

test('logout via token removal shows login page on reload', async ({ page }) => {
  await login(page);

  // Verify we're authenticated
  await expect(page.getByPlaceholder('Search sessions...')).toBeVisible({ timeout: 5000 });

  // Remove token from localStorage (simulates session expiry or manual logout)
  await page.evaluate(() => localStorage.removeItem('api_token'));

  // Reload the page
  await page.reload();

  // Should be back on login page
  await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('text=Enter your API password to connect')).toBeVisible();
});

test('login network error shows helpful message', async ({ page }) => {
  await page.goto('/');
  const passwordInput = page.locator('input[type="password"]');
  await expect(passwordInput).toBeVisible({ timeout: 10000 });

  // Abort all requests to /api/sessions to simulate network failure
  await page.route('**/api/sessions', (route) => route.abort());

  await passwordInput.fill(API_PASSWORD);
  await page.locator('button[type="submit"]').click();

  // Should show the network error message from LoginPage catch block
  await expect(page.getByText(/Unable to reach server/)).toBeVisible({ timeout: 5000 });

  // Should stay on login page
  await expect(passwordInput).toBeVisible();
});

test('mobile viewport renders session list without sidebar', async ({ page }) => {
  // Set mobile viewport before navigating
  await page.setViewportSize({ width: 375, height: 812 });

  await login(page);

  // Mobile layout renders SessionListPage with a Hatchpod h1 header
  await expect(page.locator('h1', { hasText: 'Hatchpod' })).toBeVisible({ timeout: 5000 });

  // Search bar is visible (from SessionListPage)
  await expect(page.getByPlaceholder('Search sessions...')).toBeVisible({ timeout: 5000 });

  // Sidebar collapse toggle should NOT be visible (AppShell not rendered on mobile)
  await expect(page.locator('[title="Collapse sidebar"]')).not.toBeVisible();
  await expect(page.locator('[title="Expand sidebar"]')).not.toBeVisible();
});

// --- Mobile nav bar tests ---

test('mobile nav bar is visible on session list page', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  const nav = page.getByRole('navigation', { name: 'Bottom navigation' });
  await expect(nav).toBeVisible({ timeout: 5000 });

  // All three tabs present
  await expect(nav.getByText('Sessions')).toBeVisible();
  await expect(nav.getByText('Terminal')).toBeVisible();
  await expect(nav.getByText('Settings')).toBeVisible();
});

test('mobile nav bar Sessions tab is active on session list', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  const nav = page.getByRole('navigation', { name: 'Bottom navigation' });
  await expect(nav).toBeVisible({ timeout: 5000 });

  // Sessions tab button should carry the primary color class (active)
  const sessionsBtn = nav.getByRole('button', { name: /Sessions/i });
  await expect(sessionsBtn).toHaveClass(/text-primary/);

  // Terminal and Settings tabs should be muted (inactive)
  const terminalBtn = nav.getByRole('button', { name: /Terminal/i });
  await expect(terminalBtn).toHaveClass(/text-muted-foreground/);
});

test('mobile nav bar navigates to Terminal page', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  const nav = page.getByRole('navigation', { name: 'Bottom navigation' });
  await nav.getByRole('button', { name: /Terminal/i }).click();

  // Terminal page shows a connection status indicator
  await expect(page.getByText(/Connecting|Connected|Disconnected/)).toBeVisible({ timeout: 5000 });

  // Nav bar still visible on Terminal page
  await expect(nav).toBeVisible();

  // Terminal tab is now active
  const terminalBtn = nav.getByRole('button', { name: /Terminal/i });
  await expect(terminalBtn).toHaveClass(/text-primary/);
});

test('mobile nav bar navigates to Settings page', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  const nav = page.getByRole('navigation', { name: 'Bottom navigation' });
  await nav.getByRole('button', { name: /Settings/i }).click();

  // Settings page renders a settings form
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 5000 });

  // Nav bar still visible on Settings page
  await expect(nav).toBeVisible();

  // Settings tab is active
  const settingsBtn = nav.getByRole('button', { name: /Settings/i });
  await expect(settingsBtn).toHaveClass(/text-primary/);
});

test('mobile nav bar is hidden on chat page', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  // Navigate directly to a session URL (any UUID — the WS will report history status)
  await page.goto('/#/session/00000000-0000-0000-0000-000000000001');

  // Chat page should render (composer or back button visible)
  await expect(page.getByRole('button', { name: '' }).filter({ has: page.locator('svg') }).first()).toBeVisible({ timeout: 5000 });

  // Bottom nav bar must NOT be visible on the chat page
  const nav = page.getByRole('navigation', { name: 'Bottom navigation' });
  await expect(nav).not.toBeVisible();
});
