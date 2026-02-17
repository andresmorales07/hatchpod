import { defineConfig } from '@playwright/test';

const username = process.env.TTYD_USERNAME || 'claude';
const password = process.env.TTYD_PASSWORD || 'changeme';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:7681',
    trace: 'on-first-retry',
    extraHTTPHeaders: {
      'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
    },
  ],
});
