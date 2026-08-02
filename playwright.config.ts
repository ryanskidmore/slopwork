import { defineConfig } from "@playwright/test";

const port = 4765;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: "test-results/playwright",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    colorScheme: "light",
    locale: "en-US",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      `bun run build:web && cd tests/fixtures/web-db && ` +
      `SLOP_WEB_FAKE_NOW=2026-07-20T12:00:00.000Z bun ../../../src/cli/index.ts web --port ${port}`,
    url: `http://127.0.0.1:${port}/api/config`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
