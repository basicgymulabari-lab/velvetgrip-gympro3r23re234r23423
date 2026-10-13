import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["release-center.spec.ts", "member-camera.spec.ts"],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/login",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Keep browser tests isolated from any developer or production Supabase
    // credentials. CEO tests explicitly mock this endpoint with synthetic data.
    env: {
      VITE_SUPABASE_URL: "https://release-center-test.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_release_center_browser_test",
    },
  },
});
