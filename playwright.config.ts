import { defineConfig } from '@playwright/test';

const TURSO_PORT = 8787;
const APP_PORT = 1420;

/**
 * End-to-end tests run the real app in a real browser, as a web page (no Tauri), so they cover the
 * web build's Designer-only flow. The database is a local stand-in (e2e/fakeTurso.mjs), never the
 * real Turso, and anything in your .env is overridden below.
 *
 *   pnpm exec playwright install chromium   (once)
 *   pnpm test:e2e
 *
 * PW_CHROMIUM_PATH points at an existing Chromium binary when the browser download is not possible.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH, args: (process.env.PW_CHROMIUM_ARGS ?? '').split(' ').filter(Boolean) }
      : {},
  },
  webServer: [
    {
      command: 'node e2e/fakeTurso.mjs',
      url: `http://localhost:${TURSO_PORT}/health`,
      env: { FAKE_TURSO_PORT: String(TURSO_PORT) },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm dev',
      url: `http://localhost:${APP_PORT}`,
      env: { VITE_TURSO_URL: `http://localhost:${TURSO_PORT}`, VITE_TURSO_TOKEN: 'e2e' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
