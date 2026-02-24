import { defineConfig } from '@playwright/test';

const username = process.env.TTYD_USERNAME || 'hatchpod';
const password = process.env.TTYD_PASSWORD || 'changeme';
const apiPassword = process.env.API_PASSWORD || 'changeme';
const ttydPort = process.env.TTYD_PORT || '7681';
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
      name: 'ttyd-chromium',
      testMatch: 'ttyd.spec.ts',
      use: {
        baseURL: `http://localhost:${ttydPort}`,
        browserName: 'chromium',
        trace: 'on-first-retry',
        httpCredentials: {
          username,
          password,
          send: 'always',
        },
      },
    },
    {
      name: 'ttyd-firefox',
      testMatch: 'ttyd.spec.ts',
      use: {
        baseURL: `http://localhost:${ttydPort}`,
        browserName: 'firefox',
        trace: 'on-first-retry',
        httpCredentials: {
          username,
          password,
          send: 'always',
        },
      },
    },
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
  ],
});
