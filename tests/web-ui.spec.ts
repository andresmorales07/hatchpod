import { test, expect } from '@playwright/test';

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
