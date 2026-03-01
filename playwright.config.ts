import { defineConfig } from '@playwright/test';

const apiPassword = process.env.API_PASSWORD || 'changeme';
const apiPort = process.env.API_PORT || '8080';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  projects: [
    {
      name: 'api',
      testMatch: 'api.spec.ts',
      use: {
        baseURL: `http://localhost:${apiPort}`,
        browserName: 'chromium',
        trace: 'on-first-retry',
        extraHTTPHeaders: {
          Authorization: `Bearer ${apiPassword}`,
        },
      },
    },
    {
      name: 'web-ui',
      testMatch: 'web-ui.spec.ts',
      use: {
        baseURL: `http://localhost:${apiPort}`,
        browserName: 'chromium',
        trace: 'on-first-retry',
      },
    },
    {
      name: 'web-ui-firefox',
      testMatch: 'web-ui.spec.ts',
      use: {
        baseURL: `http://localhost:${apiPort}`,
        browserName: 'firefox',
        trace: 'on-first-retry',
      },
    },
    {
      name: 'static',
      testMatch: 'static.spec.ts',
      use: {
        baseURL: `http://localhost:${apiPort}`,
        browserName: 'chromium',
        trace: 'on-first-retry',
      },
    },
    {
      name: 'ws',
      testMatch: 'ws.spec.ts',
      use: {
        baseURL: `http://localhost:${apiPort}`,
        browserName: 'chromium',
        trace: 'on-first-retry',
      },
    },
    {
      name: 'session-delivery',
      testMatch: 'session-delivery.spec.ts',
      use: {
        baseURL: `http://localhost:${apiPort}`,
        browserName: 'chromium',
        trace: 'on-first-retry',
      },
    },
    {
      name: 'terminal',
      testMatch: 'terminal.spec.ts',
      use: {
        baseURL: `http://localhost:${apiPort}`,
        browserName: 'chromium',
        trace: 'on-first-retry',
      },
    },
  ],
});
