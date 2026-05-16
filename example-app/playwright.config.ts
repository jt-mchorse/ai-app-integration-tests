import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the example-app streaming tests (#2).
 *
 * Boots `next start` against the production build with
 * ``ANTHROPIC_TEST_MODE=replay`` so `instrumentation.ts` installs the
 * deterministic Anthropic stub in `e2e/_stub.ts`. No real API key
 * required.
 *
 * Chromium-only: the issue is scoped to "stable on CI ubuntu-latest";
 * cross-browser is a follow-up.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 15_000,

  use: {
    baseURL: "http://127.0.0.1:3100",
    actionTimeout: 5_000,
    navigationTimeout: 5_000,
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "node node_modules/next/dist/bin/next start -p 3100",
    cwd: ".",
    url: "http://127.0.0.1:3100/streaming",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      ANTHROPIC_TEST_MODE: "replay",
      ANTHROPIC_API_KEY: "test-key-stubbed-by-instrumentation",
      NODE_ENV: "production",
    },
  },
});
